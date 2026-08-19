export const coverageThresholds = {
  instrumentedFilesPercent: 100,
  functionPercent: 70,
};

export function coverageFailures(rows, thresholds = coverageThresholds) {
  return rows.filter(
    (row) =>
      row.sourceFiles === 0 ||
      row.functions === 0 ||
      row.instrumentedFiles !== row.sourceFiles ||
      row.instrumentedFilesPercent < thresholds.instrumentedFilesPercent ||
      row.functionPercent < thresholds.functionPercent,
  );
}
