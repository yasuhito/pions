import type { RevisionSeriesId } from "../public.js";

const PREFIX = "pions.revision-series.v1:";

export function revisionSeriesId(seriesOriginOperationId: string): RevisionSeriesId {
  return `${PREFIX}${seriesOriginOperationId}`;
}

export function revisionSeriesOrigin(seriesId: string): string | undefined {
  if (!seriesId.startsWith(PREFIX)) return undefined;
  const origin = seriesId.slice(PREFIX.length);
  return origin.length === 0 ? undefined : origin;
}
