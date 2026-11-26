import { describe, expect, test } from "bun:test";
import { DecryptError } from "../src/crypto";
import { errorText, languages, strings } from "../src/i18n";
import { FileError, LocalChanged, NoVault } from "../src/sync";
import { TimeoutError, WebDavError } from "../src/webdav";

const en = languages.en;

/** Every string of a dictionary, functions called with sample arguments. */
function texts(d: Record<string, unknown>): [string, string][] {
  return Object.entries(d).map(([k, v]) => [k, typeof v === "function" ? String(v(...Array(v.length).fill(2))) : String(v)]);
}

describe("i18n", () => {
  for (const [lang, d] of Object.entries(languages)) {
    test(`${lang}: the same keys as English, same arity, no empty string`, () => {
      expect(Object.keys(d).sort()).toEqual(Object.keys(en).sort());
      for (const k of Object.keys(en)) {
        const a = (en as Record<string, unknown>)[k];
        const b = (d as Record<string, unknown>)[k];
        expect(typeof b).toBe(typeof a);
        if (typeof a === "function") expect((b as () => void).length).toBe(a.length);
      }
      for (const [k, s] of texts(d)) expect(s.trim(), k).not.toBe("");
    });
  }

  test("a language is picked by its code, its base, or else English", () => {
    expect(strings("es")).toBe(languages.es);
    expect(strings("es-419")).toBe(languages.es);
    expect(strings("ja")).toBe(en);
  });

  test("known errors are told in the user's language; unknown ones keep their message", () => {
    const es = languages.es;
    expect(errorText(es, new DecryptError("wrong encryption passphrase", "passphrase"))).toBe(es.errPassphrase);
    expect(errorText(es, new DecryptError("damaged file"))).toBe(es.errDecrypt(es.whyDamaged));
    expect(errorText(es, new NoVault("…", "notEmpty"))).toBe(es.errNotEmpty);
    expect(errorText(es, new FileError("…", "caseClash", "A.md"))).toBe(es.errCaseClash("A.md"));
    expect(errorText(es, new LocalChanged())).toBe(es.errChangedHere);
    expect(errorText(es, new TimeoutError("PUT", 61))).toBe(es.errTimeout(61));
    expect(errorText(es, new WebDavError("PROPFIND /: HTTP 401", 401))).toBe(es.errLogin);
    expect(errorText(es, new WebDavError("GET /x: HTTP 500", 500))).toBe(es.errHttp(500));
    expect(errorText(es, new Error("net::ERR_NAME_NOT_RESOLVED"))).toBe(es.errNetwork);
    expect(errorText(es, new Error("disk full"))).toBe("disk full");
  });
});

test("a request with no answer at all is told as no connection, in the user's language", () => {
  const es = languages.es;
  expect(errorText(es, new Error("net::ERR_INTERNET_DISCONNECTED"))).toBe(es.errNetwork);
  expect(errorText(es, new Error("getaddrinfo ENOTFOUND example.invalid"))).toBe(es.errNetwork);
  expect(errorText(es, new Error("something else"))).toBe("something else");
});
