import { isDeepStrictEqual } from "node:util";

import type { ArtifactUseBindingRequest } from "../public.js";

const AUTHORITY_BASIS = "fixed-start-authorization-policy";

export function reviewSubjectUseBindingRequest(
  operationId: string,
  artifactId: string
): ArtifactUseBindingRequest {
  return {
    bindingId: `${operationId}.review-subject`,
    operationId,
    artifactId,
    purpose: "review_subject",
    decisionId: `${operationId}.start-authorization`,
    authorityBasis: AUTHORITY_BASIS,
  };
}

export function isReviewSubjectUseBindingRequest(
  request: Readonly<ArtifactUseBindingRequest>,
  artifactId: string
): boolean {
  return isDeepStrictEqual(
    request,
    reviewSubjectUseBindingRequest(request.operationId, artifactId)
  );
}
