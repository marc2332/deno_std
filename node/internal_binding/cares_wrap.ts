// Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// This module ports:
// - https://github.com/nodejs/node/blob/master/src/cares_wrap.cc
// - https://github.com/nodejs/node/blob/master/src/cares_wrap.h

import type { ErrnoException } from "../internal/errors.ts";
import { isIPv4 } from "../internal/net.ts";
import { codeMap } from "./uv.ts";
import { AsyncWrap, providerType } from "./async_wrap.ts";
import { ares_strerror } from "./ares.ts";
import { notImplemented } from "../_utils.ts";
import { isWindows } from "../../_util/os.ts";

interface LookupAddress {
  address: string;
  family: number;
}

export class GetAddrInfoReqWrap extends AsyncWrap {
  family!: number;
  hostname!: string;

  callback!: (
    err: ErrnoException | null,
    addressOrAddresses?: string | LookupAddress[] | null,
    family?: number,
  ) => void;
  resolve!: (addressOrAddresses: LookupAddress | LookupAddress[]) => void;
  reject!: (err: ErrnoException | null) => void;
  oncomplete!: (err: number | null, addresses: string[]) => void;

  constructor() {
    super(providerType.GETADDRINFOREQWRAP);
  }
}

export function getaddrinfo(
  req: GetAddrInfoReqWrap,
  hostname: string,
  family: number,
  _hints: number,
  verbatim: boolean,
): number {
  let addresses: string[] = [];

  // TODO(cmorten): use hints
  // REF: https://nodejs.org/api/dns.html#dns_supported_getaddrinfo_flags

  const recordTypes: ("A" | "AAAA")[] = [];

  if (family === 0 || family === 4) {
    recordTypes.push("A");
  }
  if (family === 0 || family === 6) {
    recordTypes.push("AAAA");
  }

  (async () => {
    await Promise.allSettled(
      recordTypes.map((recordType) =>
        Deno.resolveDns(hostname, recordType).then((records) => {
          records.forEach((record) => addresses.push(record));
        })
      ),
    );

    const error = addresses.length ? 0 : codeMap.get("EAI_NODATA")!;

    // TODO(cmorten): needs work
    // REF: https://github.com/nodejs/node/blob/master/src/cares_wrap.cc#L1444
    if (!verbatim) {
      addresses.sort((a: string, b: string): number => {
        if (isIPv4(a)) {
          return -1;
        } else if (isIPv4(b)) {
          return 1;
        }

        return 0;
      });
    }

    // TODO: Forces IPv4 as a workaround for Deno not
    // aligning with Node on implicit binding on Windows
    // REF: https://github.com/denoland/deno/issues/10762
    if (isWindows && hostname === "localhost") {
      addresses = addresses.filter((address) => isIPv4(address));
    }

    req.oncomplete(error, addresses);
  })();

  return 0;
}

export class QueryReqWrap extends AsyncWrap {
  bindingName!: string;
  hostname!: string;
  ttl!: boolean;

  callback!: (
    err: ErrnoException | null,
    // deno-lint-ignore no-explicit-any
    records?: any,
  ) => void;
  // deno-lint-ignore no-explicit-any
  resolve!: (records: any) => void;
  reject!: (err: ErrnoException | null) => void;
  oncomplete!: (
    err: number,
    // deno-lint-ignore no-explicit-any
    records: any,
    ttls?: number[],
  ) => void;

  constructor() {
    super(providerType.QUERYWRAP);
  }
}

export interface ChannelWrapQuery {
  queryAny(req: QueryReqWrap, name: string): number;
  queryA(req: QueryReqWrap, name: string): number;
  queryAaaa(req: QueryReqWrap, name: string): number;
  queryCaa(req: QueryReqWrap, name: string): number;
  queryCname(req: QueryReqWrap, name: string): number;
  queryMx(req: QueryReqWrap, name: string): number;
  queryNs(req: QueryReqWrap, name: string): number;
  queryTxt(req: QueryReqWrap, name: string): number;
  querySrv(req: QueryReqWrap, name: string): number;
  queryPtr(req: QueryReqWrap, name: string): number;
  queryNaptr(req: QueryReqWrap, name: string): number;
  querySoa(req: QueryReqWrap, name: string): number;
  getHostByAddr(req: QueryReqWrap, name: string): number;
}

export class ChannelWrap extends AsyncWrap implements ChannelWrapQuery {
  #timeout: number;
  #tries: number;

  constructor(timeout: number, tries: number) {
    super(providerType.DNSCHANNEL);

    this.#timeout = timeout;
    this.#tries = tries;
  }

  async #query(query: string, recordType: Deno.RecordType) {
    // TODO: TTL logic.

    let ret: Awaited<ReturnType<typeof Deno.resolveDns>> = [];
    let code = 0;

    try {
      ret = await Deno.resolveDns(query, recordType);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        code = codeMap.get("EAI_NODATA")!;
      } else {
        // TODO(cmorten): map errors to appropriate error codes.
        code = codeMap.get("UNKNOWN")!;
      }
    }

    return { code, ret };
  }

  queryAny(req: QueryReqWrap, name: string): number {
    // TODO: implemented temporary measure to allow limited usage of
    // `resolveAny` like APIs.
    //
    // Ideally we move to using the "ANY" / "*" DNS query in future
    // REF: https://github.com/denoland/deno/issues/14492
    (async () => {
      const records: { type: Deno.RecordType; [key: string]: unknown }[] = [];

      await Promise.allSettled([
        this.#query(name, "A").then(({ ret }) => {
          ret.forEach((record) => records.push({ type: "A", address: record }));
        }),
        this.#query(name, "AAAA").then(({ ret }) => {
          ret.forEach((record) =>
            records.push({ type: "AAAA", address: record })
          );
        }),
        this.#query(name, "CNAME").then(({ ret }) => {
          ret.forEach((record) =>
            records.push({ type: "CNAME", value: record })
          );
        }),
        this.#query(name, "MX").then(({ ret }) => {
          (ret as Deno.MXRecord[]).forEach(({ preference, exchange }) =>
            records.push({ type: "MX", priority: preference, exchange })
          );
        }),
        this.#query(name, "PTR").then(({ ret }) => {
          ret.forEach((record) => records.push({ type: "PTR", value: record }));
        }),
        this.#query(name, "SRV").then(({ ret }) => {
          (ret as Deno.SRVRecord[]).forEach(
            ({ priority, weight, port, target }) =>
              records.push({
                type: "SRV",
                priority,
                weight,
                port,
                name: target,
              }),
          );
        }),
        this.#query(name, "TXT").then(({ ret }) => {
          ret.forEach((record) =>
            records.push({ type: "TXT", entries: record })
          );
        }),
      ]);

      const err = records.length ? 0 : codeMap.get("EAI_NODATA")!;

      req.oncomplete(err, records);
    })();

    return 0;
  }

  queryA(req: QueryReqWrap, name: string): number {
    this.#query(name, "A").then(({ code, ret }) => {
      req.oncomplete(code, ret);
    });

    return 0;
  }

  queryAaaa(req: QueryReqWrap, name: string): number {
    this.#query(name, "AAAA").then(({ code, ret }) => {
      req.oncomplete(code, ret);
    });

    return 0;
  }

  queryCaa(_req: QueryReqWrap, _name: string): number {
    notImplemented("cares.ChannelWrap.prototype.queryCaa");
  }

  queryCname(req: QueryReqWrap, name: string): number {
    this.#query(name, "CNAME").then(({ code, ret }) => {
      req.oncomplete(code, ret);
    });

    return 0;
  }

  queryMx(req: QueryReqWrap, name: string): number {
    this.#query(name, "MX").then(({ code, ret }) => {
      const records = (ret as Deno.MXRecord[]).map(
        ({ preference, exchange }) => ({
          priority: preference,
          exchange,
        }),
      );

      req.oncomplete(code, records);
    });

    return 0;
  }

  queryNs(_req: QueryReqWrap, _name: string): number {
    // TODO:
    // - https://github.com/denoland/deno/issues/14492
    // - https://github.com/denoland/deno/pull/14372
    notImplemented("cares.ChannelWrap.prototype.queryNs");
  }

  queryTxt(req: QueryReqWrap, name: string): number {
    this.#query(name, "TXT").then(({ code, ret }) => {
      req.oncomplete(code, ret);
    });

    return 0;
  }

  querySrv(req: QueryReqWrap, name: string): number {
    this.#query(name, "SRV").then(({ code, ret }) => {
      const records = (ret as Deno.SRVRecord[]).map(
        ({ priority, weight, port, target }) => ({
          priority,
          weight,
          port,
          name: target,
        }),
      );

      req.oncomplete(code, records);
    });

    return 0;
  }

  queryPtr(req: QueryReqWrap, name: string): number {
    this.#query(name, "PTR").then(({ code, ret }) => {
      req.oncomplete(code, ret);
    });

    return 0;
  }

  queryNaptr(_req: QueryReqWrap, _name: string): number {
    // TODO: https://github.com/denoland/deno/issues/14492
    notImplemented("cares.ChannelWrap.prototype.queryNaptr");
  }

  querySoa(_req: QueryReqWrap, _name: string): number {
    // TODO:
    // - https://github.com/denoland/deno/issues/14492
    // - https://github.com/denoland/deno/pull/14374
    notImplemented("cares.ChannelWrap.prototype.querySoa");
  }

  getHostByAddr(_req: QueryReqWrap, _name: string): number {
    // TODO: https://github.com/denoland/deno/issues/14432
    notImplemented("cares.ChannelWrap.prototype.getHostByAddr");
  }

  getServers(): [string, number][] {
    notImplemented("cares.ChannelWrap.prototype.getServers");
  }

  setServers(_servers: string | [number, string, number][]): number {
    notImplemented("cares.ChannelWrap.prototype.setServers");
  }

  setLocalAddress(_addr0: string, _addr1?: string): void {
    notImplemented("cares.ChannelWrap.prototype.setLocalAddress");
  }

  cancel() {
    notImplemented("cares.ChannelWrap.prototype.cancel");
  }
}

const DNS_ESETSRVPENDING = -1000;
const EMSG_ESETSRVPENDING = "There are pending queries.";

export function strerror(code: number) {
  return code === DNS_ESETSRVPENDING
    ? EMSG_ESETSRVPENDING
    : ares_strerror(code);
}
