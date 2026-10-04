import { describe, it, expect } from "vitest";
import {
  renderMergeVars,
  renderSpintax,
  renderTemplate,
  withSenderFooter,
  withSenderFooterHtml,
  composeBody,
  leadMergeVars,
} from "../template.js";
import { seededRng } from "../util.js";

describe("renderMergeVars", () => {
  it("resolves firstName from full name", () => {
    expect(
      renderMergeVars("Hi {{firstName}} at {{company}}", {
        name: "Jane Doe",
        company: "Acme",
      }),
    ).toBe("Hi Jane at Acme");
  });

  it("empty for unknown vars", () => {
    expect(renderMergeVars("Hi {{missing}}!", {})).toBe("Hi !");
  });

  it("matches keys case- and separator-insensitively", () => {
    expect(renderMergeVars("{{first_name}} {{First-Name}} {{ first name }}", { firstName: "Sam" })).toBe("Sam Sam Sam");
  });
});

describe("renderSpintax", () => {
  it("always picks a valid option", () => {
    const rng = seededRng(42);
    for (let i = 0; i < 20; i++) {
      const out = renderSpintax("{Hi|Hello|Hey} there", rng);
      expect(["Hi there", "Hello there", "Hey there"]).toContain(out);
    }
  });

  it("varies output across seeds (pattern defense)", () => {
    const outs = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map((s) => renderSpintax("{a|b|c|d}", seededRng(s))),
    );
    expect(outs.size).toBeGreaterThan(1);
  });
});

describe("renderTemplate", () => {
  it("applies merge vars then spintax", () => {
    const out = renderTemplate("{Hi|Hello} {{firstName}}", { firstName: "Sam" }, seededRng(1));
    expect(out === "Hi Sam" || out === "Hello Sam").toBe(true);
  });
});

describe("withSenderFooter", () => {
  it("includes sender identity only, no unsubscribe link", () => {
    const out = withSenderFooter("Body here", { senderName: "Sam", company: "Acme LLC" });
    expect(out).toContain("Sam");
    expect(out).toContain("Acme LLC");
    expect(out).not.toContain("unsubscribe");
  });

  it("puts name and title/company on separate lines, title capitalized", () => {
    const out = withSenderFooter("Body here", {
      senderName: "Alex",
      company: "Acme",
      title: "founder",
    });
    expect(out).toContain("--\nAlex\nFounder, Acme");
  });

  it("falls back to company-only line when no title is given", () => {
    const out = withSenderFooter("Body here", { senderName: "Sam", company: "Acme LLC" });
    expect(out).toContain("--\nSam\nAcme LLC");
  });

  it("appends the postal address as its own line", () => {
    const out = withSenderFooter("Body", {
      senderName: "Sam",
      company: "Acme LLC",
      postalAddress: "1 Main St, Springfield",
    });
    expect(out).toContain("--\nSam\nAcme LLC\n1 Main St, Springfield");
  });

  it("returns the body untouched when no identity is configured", () => {
    expect(withSenderFooter("Body", { senderName: "", company: "" })).toBe("Body");
    expect(withSenderFooterHtml("<p>Body</p>", { senderName: "", company: "" })).toBe(
      "<p>Body</p>",
    );
  });

  it("escapes HTML in the HTML footer", () => {
    const out = withSenderFooterHtml("<p>x</p>", { senderName: "<b>Sam</b>", company: "A&B" });
    expect(out).toContain("&lt;b&gt;Sam&lt;/b&gt;<br>A&amp;B");
  });
});

describe("composeBody", () => {
  const sender = { senderName: "Sam", company: "Acme" };

  it("default footer when override is null, after the signature", () => {
    const out = composeBody({
      body: "Hi",
      isHtml: false,
      signature: "Sig",
      footerOverride: null,
      sender,
    });
    expect(out.indexOf("Sig")).toBeLessThan(out.indexOf("--"));
    expect(out).toContain("Sam\nAcme");
  });

  it("no footer when override is empty", () => {
    expect(composeBody({ body: "Hi", isHtml: false, footerOverride: "", sender })).toBe("Hi");
  });

  it("custom footer verbatim", () => {
    expect(composeBody({ body: "Hi", isHtml: false, footerOverride: "Bye", sender })).toBe(
      "Hi\n\nBye",
    );
  });
});

describe("leadMergeVars", () => {
  it("exposes custom fields but never lets them shadow built-ins", () => {
    const vars = leadMergeVars({
      name: "Jane Doe",
      email: "jane@acme.com",
      company: "Acme",
      customFields: { company: "Other", Industry: "Logistics" },
    });
    expect(renderMergeVars("{{firstName}} / {{company}} / {{industry}}", vars)).toBe(
      "Jane / Acme / Logistics",
    );
  });
});
