import { describe, it, expect } from "vitest";
import {
  expandTilde,
  escapeId,
  qualifiedTable,
  toolOk,
  toolError,
  formatAsTable,
  humanSize,
  stripSQLComments,
} from "../helpers.js";
import { homedir } from "node:os";

// ── expandTilde ─────────────────────────────────────────────────────

describe("expandTilde", () => {
  it("expands ~/ to home directory", () => {
    expect(expandTilde("~/.ssh/key")).toBe(`${homedir()}/.ssh/key`);
  });

  it("expands bare ~ to home directory", () => {
    expect(expandTilde("~")).toBe(homedir());
  });

  it("does not expand ~ in the middle of a path", () => {
    expect(expandTilde("/home/~user")).toBe("/home/~user");
  });

  it("returns absolute paths unchanged", () => {
    expect(expandTilde("/etc/ssl/cert.pem")).toBe("/etc/ssl/cert.pem");
  });

  it("returns relative paths unchanged", () => {
    expect(expandTilde("./config.json")).toBe("./config.json");
  });
});

// ── escapeId ────────────────────────────────────────────────────────

describe("escapeId", () => {
  it("wraps name in backticks", () => {
    expect(escapeId("users")).toBe("`users`");
  });

  it("doubles backticks inside the name", () => {
    expect(escapeId("my`table")).toBe("`my``table`");
  });

  it("handles multiple backticks", () => {
    expect(escapeId("a`b`c")).toBe("`a``b``c`");
  });

  it("rejects empty names", () => {
    expect(() => escapeId("")).toThrow("cannot be empty");
  });

  it("rejects names containing NUL bytes", () => {
    expect(() => escapeId("users\0")).toThrow("NUL bytes");
  });

  it("rejects names longer than 64 characters", () => {
    expect(() => escapeId("a".repeat(65))).toThrow("too long");
  });

  it("accepts names exactly 64 characters", () => {
    expect(escapeId("a".repeat(64))).toBe("`" + "a".repeat(64) + "`");
  });

  it("handles special characters safely", () => {
    expect(escapeId("table; DROP TABLE--")).toBe("`table; DROP TABLE--`");
  });
});

// ── qualifiedTable ──────────────────────────────────────────────────

describe("qualifiedTable", () => {
  it("combines db and table with dot", () => {
    expect(qualifiedTable("mydb", "users")).toBe("`mydb`.`users`");
  });

  it("escapes both parts", () => {
    expect(qualifiedTable("my`db", "my`table")).toBe("`my``db`.`my``table`");
  });
});

// ── toolOk / toolError ──────────────────────────────────────────────

describe("toolOk", () => {
  it("wraps text in MCP content format", () => {
    expect(toolOk("hello")).toEqual({
      content: [{ type: "text", text: "hello" }],
    });
  });
});

describe("toolError", () => {
  it("returns error with isError flag", () => {
    const result = toolError("something broke");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("something broke");
  });

  it("appends hint when provided", () => {
    const result = toolError("fail", "try again");
    expect(result.content[0].text).toBe("fail\nHint: try again");
  });
});

// ── formatAsTable ───────────────────────────────────────────────────

describe("formatAsTable", () => {
  it("returns (empty) for empty array", () => {
    expect(formatAsTable([])).toBe("(empty)");
  });

  it("formats single row", () => {
    const result = formatAsTable([{ id: 1, name: "alice" }]);
    expect(result).toContain("id");
    expect(result).toContain("name");
    expect(result).toContain("1");
    expect(result).toContain("alice");
  });

  it("formats multiple rows with alignment", () => {
    const rows = [
      { col: "a", val: "short" },
      { col: "b", val: "longer value" },
    ];
    const lines = formatAsTable(rows).split("\n");
    expect(lines.length).toBe(4); // header + separator + 2 rows
    expect(lines[1]).toMatch(/^-+\+-+$/); // separator line
  });

  it("shows NULL for null/undefined values", () => {
    const result = formatAsTable([{ a: null, b: undefined }]);
    expect(result).toContain("NULL");
  });

  it("truncates long values with maxWidth", () => {
    const result = formatAsTable(
      [{ col: "a".repeat(100) }],
      { maxWidth: 20 }
    );
    expect(result).toContain("...");
    expect(result).not.toContain("a".repeat(100));
  });
});

// ── humanSize ───────────────────────────────────────────────────────

describe("humanSize", () => {
  it("returns N/A for null", () => {
    expect(humanSize(null)).toBe("N/A");
  });

  it("returns N/A for undefined", () => {
    expect(humanSize(undefined)).toBe("N/A");
  });

  it("formats bytes", () => {
    expect(humanSize(500)).toBe("500 B");
  });

  it("formats kilobytes", () => {
    expect(humanSize(2048)).toBe("2.0 KB");
  });

  it("formats megabytes", () => {
    expect(humanSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("formats gigabytes", () => {
    expect(humanSize(2.5 * 1024 * 1024 * 1024)).toBe("2.50 GB");
  });

  it("handles zero", () => {
    expect(humanSize(0)).toBe("0 B");
  });
});

// ── stripSQLComments ────────────────────────────────────────────────

describe("stripSQLComments", () => {
  it("strips block comments", () => {
    expect(stripSQLComments("/* comment */ SELECT 1")).toBe("SELECT 1");
  });

  it("strips multi-line block comments", () => {
    expect(stripSQLComments("/*\nmulti\nline\n*/ SELECT 1")).toBe("SELECT 1");
  });

  it("strips -- line comments", () => {
    expect(stripSQLComments("SELECT 1 -- comment")).toBe("SELECT 1");
  });

  it("strips # line comments", () => {
    expect(stripSQLComments("SELECT 1 # comment")).toBe("SELECT 1");
  });

  it("strips multiple comment types", () => {
    const result = stripSQLComments("/* a */ SELECT -- b\n1 # c");
    expect(result).toContain("SELECT");
    expect(result).toContain("1");
    expect(result).not.toContain("/* a */");
    expect(result).not.toContain("-- b");
    expect(result).not.toContain("# c");
  });

  it("returns empty string for comment-only input", () => {
    expect(stripSQLComments("/* just a comment */")).toBe("");
  });

  it("preserves query with no comments", () => {
    expect(stripSQLComments("SELECT * FROM users")).toBe("SELECT * FROM users");
  });
});
