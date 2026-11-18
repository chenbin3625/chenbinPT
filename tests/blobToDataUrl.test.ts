import { afterEach, describe, expect, it, vi } from "vitest";
import { blobToDataUrl } from "~/helper.ts";

afterEach(() => vi.restoreAllMocks());

describe("shared Blob data URLs", () => {
  it("preserves the MIME type and encodes the original bytes", async () => {
    await expect(blobToDataUrl(new Blob(["hello"], { type: "image/png" }))).resolves.toBe(
      "data:image/png;base64,aGVsbG8=",
    );
  });

  it("supports an empty Blob", async () => {
    await expect(blobToDataUrl(new Blob([], { type: "image/png" }))).resolves.toBe("data:image/png;base64,");
  });

  it.each(["error", "abort"])("rejects %s instead of waiting forever", async (event) => {
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
      this.dispatchEvent(new ProgressEvent(event));
    });
    await expect(blobToDataUrl(new Blob(["data"]))).rejects.toThrow();
  });
});
