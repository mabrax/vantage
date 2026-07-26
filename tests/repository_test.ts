import assert from "node:assert/strict";
import { VantageError } from "../src/errors.ts";
import { validateRepository } from "../src/repository.ts";

Deno.test("repository validation rejects missing and non-Git paths", async () => {
  await assert.rejects(
    () => validateRepository("   "),
    (error) =>
      error instanceof VantageError &&
      error.code === "repository" &&
      /enter a local Git repository path/i.test(error.message),
  );
  await assert.rejects(
    () => validateRepository("/path/that/vantage/does/not/have"),
    (error) => error instanceof VantageError && error.code === "repository",
  );

  const directory = await Deno.makeTempDir({ prefix: "vantage-non-git-" });
  try {
    await assert.rejects(
      () => validateRepository(directory),
      (error) => error instanceof VantageError && error.code === "repository",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("repository validation returns the canonical Git root", async () => {
  const directory = await Deno.makeTempDir({ prefix: "vantage-git-" });
  const nested = `${directory}/nested`;
  try {
    await new Deno.Command("git", {
      args: ["init", "--quiet", directory],
    }).output();
    await Deno.mkdir(nested);
    assert.equal(
      await validateRepository(nested),
      await Deno.realPath(directory),
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("repository validation rejects a Git root behind an inaccessible parent", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "vantage-inaccessible-",
  });
  const root = `${directory}/repository`;
  try {
    await Deno.mkdir(root);
    await new Deno.Command("git", {
      args: ["init", "--quiet", root],
    }).output();
    await Deno.chmod(directory, 0o000);
    await assert.rejects(
      () => validateRepository(root),
      (error) =>
        error instanceof VantageError &&
        error.code === "repository" &&
        /accessible directory/i.test(error.message),
    );
  } finally {
    await Deno.chmod(directory, 0o700);
    await Deno.remove(directory, { recursive: true });
  }
});
