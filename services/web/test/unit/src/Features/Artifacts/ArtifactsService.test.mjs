import { expect, describe, it } from "vitest";
import { categorize } from "../../../../../app/src/Features/Artifacts/ArtifactsService.mjs";

describe("ArtifactsService.categorize", function () {
  it("groups data files", function () {
    expect(categorize("results.csv")).to.equal("data");
    expect(categorize("experiment.json")).to.equal("data");
    expect(categorize("model.h5")).to.equal("data");
  });

  it("groups figures", function () {
    expect(categorize("figure1.png")).to.equal("figure");
    expect(categorize("plot.PDF")).to.equal("figure");
  });

  it("groups analysis code", function () {
    expect(categorize("analysis.py")).to.equal("code");
    expect(categorize("fit.R")).to.equal("code");
  });

  it("classifies unknown extensions as other", function () {
    expect(categorize("output.xyz")).to.equal("other");
  });

  it("is case-insensitive on extensions", function () {
    expect(categorize("DATA.CSV")).to.equal("data");
  });
});
