import { graphPositionsForLibrary } from "../src/modules/graphLayout";

describe("graphPositionsForLibrary", () => {
  it("drops cross-library, malformed, and non-finite coordinates", () => {
    expect(graphPositionsForLibrary(2, {
      "1:OLD": [9, 9],
      "2:GOOD": [1.5, -4],
      "2:STRINGS": ["3", "4"],
      "2:SHORT": [1],
      "2:NAN": [Number.NaN, 2],
      unscoped: [5, 6],
    })).toEqual({
      "2:GOOD": [1.5, -4],
      "2:STRINGS": [3, 4],
    });
  });
});
