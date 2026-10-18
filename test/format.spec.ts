import { expect } from "chai";
import { bounded, show } from "../src/format.js";

describe("bounded", () => {
    it("escapes only the characters it keeps", () => {
        const started = Date.now();
        const out = bounded("\n".repeat(30_000_000));
        expect(Date.now() - started).to.be.below(1_000);
        expect(out.length).to.equal(80);
        expect(out.endsWith("...")).to.equal(true);
    });

    it("keeps short text whole and marks cut text", () => {
        expect(bounded("a\nb")).to.equal("a\\u000ab");
        expect(bounded("x".repeat(81))).to.equal(`${"x".repeat(77)}...`);
        expect(bounded("x".repeat(80))).to.equal("x".repeat(80));
    });
});

describe("show", () => {
    it("escapes only the start of a long string, as a value and as an object key", () => {
        for (const value of ["\n".repeat(100_000_000), { ["\n".repeat(100_000_000)]: 1 }]) {
            const started = Date.now();
            const out = show(value);
            expect(Date.now() - started).to.be.below(100);
            expect(out.length).to.equal(80);
            expect(out.endsWith("...")).to.equal(true);
        }
    });

    it("quotes a short string", () => {
        expect(show("a\"b")).to.equal('"a\\"b"');
    });
});
