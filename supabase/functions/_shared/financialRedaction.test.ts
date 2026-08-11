import { redactFinancialInfo, redactFinancialInfoDeep } from "./financialRedaction.ts";
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("redacts a valid Visa card number", () => {
  const out = redactFinancialInfo("Your card 4111 1111 1111 1111 was charged $42.10.");
  assertStringIncludes(out, "[REDACTED-CARD]");
  assertEquals(out.includes("4111"), false);
});

Deno.test("redacts a bank account number in a transaction alert", () => {
  const out = redactFinancialInfo(
    "A payment of $500.00 was debited from account number 000123456789 on Aug 9.",
  );
  assertEquals(out.includes("000123456789"), false);
});

Deno.test("redacts a US routing number", () => {
  const out = redactFinancialInfo("Routing number: 021000021, Account: 987654321");
  assertEquals(out.includes("021000021"), false);
  assertEquals(out.includes("987654321"), false);
});

Deno.test("redacts an SSN", () => {
  const out = redactFinancialInfo("SSN on file: 123-45-6789");
  assertStringIncludes(out, "[REDACTED-SSN]");
});

Deno.test("redacts an IBAN", () => {
  const out = redactFinancialInfo("Wire to IBAN GB29 NWBK 6016 1331 9268 19 please.");
  assertStringIncludes(out, "[REDACTED-IBAN]");
});

Deno.test("leaves ordinary decision text untouched", () => {
  const out = redactFinancialInfo("Chose PostgreSQL for the context layer instead of MongoDB.");
  assertEquals(out, "Chose PostgreSQL for the context layer instead of MongoDB.");
});

Deno.test("deep-redacts nested raw_content shapes (Notion-style pages)", () => {
  const page = {
    properties: { Title: { text: "Vendor payment" } },
    blocks: [{ text: "Wire 4111111111111111 to account 000123456789" }],
  };
  const out = redactFinancialInfoDeep(page) as typeof page;
  assertEquals(JSON.stringify(out).includes("4111111111111111"), false);
  assertEquals(JSON.stringify(out).includes("000123456789"), false);
});
