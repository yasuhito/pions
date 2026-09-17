import type {
  DeploymentMode,
  ResourceAdapterIdentity,
  ResourceAuthorityRegistration,
} from "../public.js";
import { sha256Digest } from "./result-digest.js";

export interface ResourceAdapterApprovalPolicy {
  readonly deployment: DeploymentMode;
  readonly approvedAdapters: ReadonlyArray<Readonly<ResourceAdapterIdentity>>;
}

export function resourceAdapterIdentitiesMatch(
  left: Readonly<ResourceAdapterIdentity>,
  right: Readonly<ResourceAdapterIdentity>
): boolean {
  return (
    left.adapterId === right.adapterId &&
    left.version === right.version &&
    left.digest === right.digest &&
    left.intendedUse === right.intendedUse
  );
}

export function validResourceAuthorityIdentity(
  registration: Readonly<ResourceAuthorityRegistration>
): boolean {
  const identity = registration.identity;
  return (
    identity.adapterId.length > 0 &&
    identity.version.length > 0 &&
    (identity.intendedUse === "non-production" ||
      identity.intendedUse === "production") &&
    sha256Digest(registration.registrationArtifact) === identity.digest
  );
}

export function resourceAuthorityIsApproved(
  registration: Readonly<ResourceAuthorityRegistration>,
  policy: Readonly<ResourceAdapterApprovalPolicy>
): boolean {
  return (
    validResourceAuthorityIdentity(registration) &&
    policy.approvedAdapters.some((approved) =>
      resourceAdapterIdentitiesMatch(approved, registration.identity)
    ) &&
    (policy.deployment !== "production" ||
      registration.identity.intendedUse === "production")
  );
}
