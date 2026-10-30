/**
 * h3 lane report: the SSRF policy let through IPv6 forms that reach a
 * non-public IPv4 address or are not public unicast: 6to4 (2002::/16, the
 * next 32 bits are an IPv4 address), Teredo (2001::/32), discard-only
 * (100::/64) and IPv4-translated (::ffff:0:a.b.c.d).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isNonPublicAddress } from "./urlPolicy.js";

test("IPv6 forms that embed a private IPv4 or are not public unicast are refused", () => {
  for (const ip of [
    "2002:7f00:1::", // 6to4 of 127.0.0.1
    "2002:a9fe:a9fe::1", // 6to4 of 169.254.169.254
    "2002:0a00:0001::", // 6to4 of 10.0.0.1
    "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo
    "100::1", // discard-only
    "::ffff:0:127.0.0.1", // IPv4-translated
    "::ffff:0:a9fe:a9fe",
  ]) {
    assert.equal(isNonPublicAddress(ip), true, ip);
  }
});

test("public IPv6 addresses, including 6to4 of a public IPv4, stay allowed", () => {
  for (const ip of ["2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "2002:0808:0808::1"]) {
    assert.equal(isNonPublicAddress(ip), false, ip);
  }
});
