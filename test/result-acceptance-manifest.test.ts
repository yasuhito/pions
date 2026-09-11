import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveWorkProductRequirements,
  resultAcceptanceManifestDocument,
  validateResultAcceptanceManifest,
  type ArtifactMetadata,
  type ResultAcceptanceManifest,
  type WorkProductRequirementsPolicy,
} from "../src/index.js";

const policy: WorkProductRequirementsPolicy = {
  body: {
    formatId: "pions.result-body.utf8.v1",
    normalizationId: "pions.bytes.identity.v1",
    maxByteCount: 100,
  },
  workProducts: [
    {
      key: "patch",
      formatId: "pions.patch.v1",
      normalizationId: "pions.bytes.identity.v1",
      minCount: 1,
      maxCount: 2,
      maxByteCount: 100,
    },
  ],
  maxTotalByteCount: 300,
};

function resolveRequirements(value: WorkProductRequirementsPolicy) {
  return resolveWorkProductRequirements({ workProductRequirements: value });
}

const requirements = resolveRequirements(policy);

function artifact(
  artifactId: string,
  byteCount: number,
  formatId: string,
  dependencies: ReadonlyArray<string> = []
): ArtifactMetadata {
  return {
    artifactId,
    byteCount,
    digest: `sha256:${"a".repeat(64)}`,
    formatId,
    normalizationId: "pions.bytes.identity.v1",
    dependencies,
  };
}

function manifest(
  overrides: Partial<ResultAcceptanceManifest> = {}
): ResultAcceptanceManifest {
  return {
    formatId: "pions.result-acceptance-manifest.v1",
    normalizationId: "pions.canonical-json.v1",
    bodyArtifactId: "body",
    requirementSetId: requirements.requirementSetId,
    requirementSetDigest: requirements.digest,
    workProducts: [{ key: "patch", artifactIds: ["patch-2", "patch-1"] }],
    ...overrides,
  };
}

const artifacts = [
  artifact("body", 20, "pions.result-body.utf8.v1"),
  artifact("patch-1", 30, "pions.patch.v1"),
  artifact("patch-2", 40, "pions.patch.v1"),
];

test("work product requirements use canonical JSON", () => {
  assert.equal(
    requirements.canonicalJson,
    '{"body":{"formatId":"pions.result-body.utf8.v1","maxByteCount":100,"normalizationId":"pions.bytes.identity.v1"},"maxTotalByteCount":300,"workProducts":[{"formatId":"pions.patch.v1","key":"patch","maxByteCount":100,"maxCount":2,"minCount":1,"normalizationId":"pions.bytes.identity.v1"}]}'
  );
});

test("work product requirement IDs are derived from the canonical JSON SHA-256", () => {
  assert.equal(
    requirements.requirementSetId,
    "pions.work-product-requirements.v1:a1461409e07d4060e8c2629ee79f6bfa91c1672c84f2a4a239adfff622445e08"
  );
});

test("work product requirement digests are derived from canonical JSON bytes", () => {
  assert.equal(
    requirements.digest,
    "sha256:a1461409e07d4060e8c2629ee79f6bfa91c1672c84f2a4a239adfff622445e08"
  );
});

test("work product requirement canonical JSON does not depend on object property order", () => {
  const reordered: WorkProductRequirementsPolicy = {
    maxTotalByteCount: 300,
    workProducts: [
      {
        maxByteCount: 100,
        maxCount: 2,
        minCount: 1,
        normalizationId: "pions.bytes.identity.v1",
        formatId: "pions.patch.v1",
        key: "patch",
      },
    ],
    body: {
      maxByteCount: 100,
      normalizationId: "pions.bytes.identity.v1",
      formatId: "pions.result-body.utf8.v1",
    },
  };

  assert.equal(
    resolveRequirements(reordered).canonicalJson,
    requirements.canonicalJson
  );
});

test("work product requirement IDs do not depend on requirement input order", () => {
  const log = { ...policy.workProducts[0]!, key: "log" };
  const patch = policy.workProducts[0]!;

  assert.equal(
    resolveRequirements({ ...policy, workProducts: [log, patch] })
      .requirementSetId,
    resolveRequirements({ ...policy, workProducts: [patch, log] })
      .requirementSetId
  );
});

test("work product requirements reject duplicate keys", () => {
  assert.throws(
    () =>
      resolveRequirements({
        ...policy,
        workProducts: [policy.workProducts[0]!, policy.workProducts[0]!],
      }),
    { name: "WorkProductRequirementsError", reason: "duplicate_key" }
  );
});

test("work product requirements accept ASCII spaces in keys", () => {
  assert.equal(
    resolveRequirements({
      ...policy,
      workProducts: [{ ...policy.workProducts[0]!, key: "build log" }],
    }).workProducts[0]?.key,
    "build log"
  );
});

test("work product requirements reject non-ASCII keys", () => {
  assert.throws(
    () =>
      resolveRequirements({
        ...policy,
        workProducts: [{ ...policy.workProducts[0]!, key: "差分" }],
      }),
    { name: "WorkProductRequirementsError", reason: "invalid_key" }
  );
});

test("work product requirements permit zero byte limits", () => {
  const zero = resolveRequirements({
    body: { ...policy.body, maxByteCount: 0 },
    workProducts: [],
    maxTotalByteCount: 0,
  });

  assert.equal(zero.maxTotalByteCount, 0);
});

test("work product requirements reject an invalid count range", () => {
  assert.throws(
    () =>
      resolveRequirements({
        ...policy,
        workProducts: [{ ...policy.workProducts[0]!, minCount: 3 }],
      }),
    { name: "WorkProductRequirementsError", reason: "invalid_requirement" }
  );
});

test("acceptance manifests sort work product keys and artifact IDs", () => {
  const document = resultAcceptanceManifestDocument(
    manifest({
      workProducts: [
        { key: "z-log", artifactIds: ["log-2", "log-1"] },
        { key: "patch", artifactIds: ["patch-2", "patch-1"] },
      ],
    })
  );

  assert.deepEqual(document.value.workProducts, [
    { key: "patch", artifactIds: ["patch-1", "patch-2"] },
    { key: "z-log", artifactIds: ["log-1", "log-2"] },
  ]);
});

test("acceptance manifest digests do not depend on list input order", () => {
  const first = resultAcceptanceManifestDocument(
    manifest({
      workProducts: [
        { key: "z-log", artifactIds: ["log-2", "log-1"] },
        { key: "patch", artifactIds: ["patch-2", "patch-1"] },
      ],
    })
  );
  const second = resultAcceptanceManifestDocument(
    manifest({
      workProducts: [
        { key: "patch", artifactIds: ["patch-1", "patch-2"] },
        { key: "z-log", artifactIds: ["log-1", "log-2"] },
      ],
    })
  );

  assert.equal(first.digest, second.digest);
});

test("acceptance manifests reject duplicate work product keys before normalization", () => {
  assert.throws(
    () =>
      resultAcceptanceManifestDocument(
        manifest({
          workProducts: [
            { key: "patch", artifactIds: ["patch-1"] },
            { key: "patch", artifactIds: ["patch-2"] },
          ],
        })
      ),
    { name: "ResultAcceptanceManifestError", reason: "duplicate_key" }
  );
});

test("acceptance manifests reject unknown fields", () => {
  assert.throws(
    () =>
      resultAcceptanceManifestDocument({
        ...manifest(),
        ignored: true,
      } as never),
    { name: "ResultAcceptanceManifestError", reason: "unknown_field" }
  );
});

test("acceptance manifest byte access cannot mutate its canonical document", () => {
  const document = resultAcceptanceManifestDocument(manifest());
  document.bytes[0] = 0;

  assert.equal(document.bytes[0], "{".charCodeAt(0));
});

test("acceptance manifests preserve Unicode and newlines", () => {
  const document = resultAcceptanceManifestDocument(
    manifest({ bodyArtifactId: "本文\n🚀" })
  );

  assert.equal(document.value.bodyArtifactId, "本文\n🚀");
});

test("acceptance manifests reject unsupported format IDs", () => {
  assert.throws(
    () =>
      resultAcceptanceManifestDocument({
        ...manifest(),
        formatId: "future",
      } as never),
    { name: "ResultAcceptanceManifestError", reason: "unsupported_format" }
  );
});

test("acceptance manifests reject unsupported normalization IDs", () => {
  assert.throws(
    () =>
      resultAcceptanceManifestDocument({
        ...manifest(),
        normalizationId: "future",
      } as never),
    {
      name: "ResultAcceptanceManifestError",
      reason: "unsupported_normalization",
    }
  );
});

test("a valid acceptance manifest returns its canonical document", () => {
  assert.equal(
    validateResultAcceptanceManifest(manifest(), requirements, artifacts).value
      .bodyArtifactId,
    "body"
  );
});

test("acceptance validation rejects a missing required work product", () => {
  assert.throws(
    () =>
      validateResultAcceptanceManifest(
        manifest({ workProducts: [] }),
        requirements,
        artifacts
      ),
    {
      name: "ResultAcceptanceManifestError",
      reason: "missing_required_work_product",
    }
  );
});

test("acceptance validation permits an omitted optional work product", () => {
  const optional = resolveRequirements({
    ...policy,
    workProducts: [{ ...policy.workProducts[0]!, minCount: 0 }],
  });

  assert.equal(
    validateResultAcceptanceManifest(
      manifest({
        requirementSetId: optional.requirementSetId,
        requirementSetDigest: optional.digest,
        workProducts: [],
      }),
      optional,
      artifacts
    ).value.workProducts.length,
    0
  );
});

test("acceptance validation rejects a work product below its minimum count", () => {
  assert.throws(
    () =>
      validateResultAcceptanceManifest(
        manifest({ workProducts: [{ key: "patch", artifactIds: [] }] }),
        requirements,
        artifacts
      ),
    {
      name: "ResultAcceptanceManifestError",
      reason: "work_product_count_below_minimum",
    }
  );
});

test("acceptance validation rejects a work product above its maximum count", () => {
  assert.throws(
    () =>
      validateResultAcceptanceManifest(
        manifest({
          workProducts: [
            { key: "patch", artifactIds: ["patch-1", "patch-2", "patch-3"] },
          ],
        }),
        requirements,
        [...artifacts, artifact("patch-3", 10, "pions.patch.v1")]
      ),
    {
      name: "ResultAcceptanceManifestError",
      reason: "work_product_count_exceeded",
    }
  );
});

test("acceptance validation rejects an undeclared work product", () => {
  assert.throws(
    () =>
      validateResultAcceptanceManifest(
        manifest({ workProducts: [{ key: "log", artifactIds: ["patch-1"] }] }),
        requirements,
        artifacts
      ),
    { name: "ResultAcceptanceManifestError", reason: "undeclared_key" }
  );
});

test("acceptance validation rejects an artifact format mismatch", () => {
  assert.throws(
    () =>
      validateResultAcceptanceManifest(manifest(), requirements, [
        artifacts[0]!,
        { ...artifacts[1]!, formatId: "wrong" },
        artifacts[2]!,
      ]),
    {
      name: "ResultAcceptanceManifestError",
      reason: "artifact_format_mismatch",
    }
  );
});

test("acceptance validation rejects an artifact normalization mismatch", () => {
  assert.throws(
    () =>
      validateResultAcceptanceManifest(manifest(), requirements, [
        artifacts[0]!,
        { ...artifacts[1]!, normalizationId: "wrong" },
        artifacts[2]!,
      ]),
    {
      name: "ResultAcceptanceManifestError",
      reason: "artifact_normalization_mismatch",
    }
  );
});

test("acceptance validation rejects an artifact above its byte limit", () => {
  assert.throws(
    () =>
      validateResultAcceptanceManifest(manifest(), requirements, [
        { ...artifacts[0]!, byteCount: 101 },
        artifacts[1]!,
        artifacts[2]!,
      ]),
    { name: "ResultAcceptanceManifestError", reason: "artifact_size_exceeded" }
  );
});

test("acceptance validation counts a dependency once when reached twice", () => {
  const shared = artifact("shared", 180, "opaque");
  const dependentArtifacts = [
    artifact("body", 20, "pions.result-body.utf8.v1", ["shared"]),
    artifact("patch-1", 30, "pions.patch.v1", ["shared"]),
  ];

  assert.equal(
    validateResultAcceptanceManifest(
      manifest({ workProducts: [{ key: "patch", artifactIds: ["patch-1"] }] }),
      requirements,
      [...dependentArtifacts, shared]
    ).totalByteCount,
    230
  );
});

test("acceptance validation rejects a dependency closure above the total byte limit", () => {
  const shared = artifact("shared", 251, "opaque");
  assert.throws(
    () =>
      validateResultAcceptanceManifest(
        manifest({
          workProducts: [{ key: "patch", artifactIds: ["patch-1"] }],
        }),
        requirements,
        [
          artifact("body", 20, "pions.result-body.utf8.v1", ["shared"]),
          artifact("patch-1", 30, "pions.patch.v1"),
          shared,
        ]
      ),
    { name: "ResultAcceptanceManifestError", reason: "total_size_exceeded" }
  );
});

test("acceptance validation counts different artifact IDs with the same digest separately", () => {
  const smallRequirements = resolveRequirements({
    ...policy,
    maxTotalByteCount: 80,
  });
  assert.throws(
    () =>
      validateResultAcceptanceManifest(
        manifest({
          requirementSetId: smallRequirements.requirementSetId,
          requirementSetDigest: smallRequirements.digest,
        }),
        smallRequirements,
        artifacts
      ),
    { name: "ResultAcceptanceManifestError", reason: "total_size_exceeded" }
  );
});

test("acceptance validation rejects modified resolved requirements", () => {
  assert.throws(
    () =>
      validateResultAcceptanceManifest(
        manifest(),
        { ...requirements, maxTotalByteCount: 80 },
        artifacts
      ),
    {
      name: "ResultAcceptanceManifestError",
      reason: "requirement_set_mismatch",
    }
  );
});

test("profile requirement resolution propagates configuration read failures without producing requirements", () => {
  const profile = Object.defineProperty({}, "workProductRequirements", {
    get() {
      throw new Error("configuration unavailable");
    },
  });

  assert.throws(
    () => resolveWorkProductRequirements(profile as never),
    /configuration unavailable/
  );
});

test("Task input cannot override profile work product requirements", () => {
  const weaker = { ...policy, workProducts: [] };
  const profile = {
    workProductRequirements: policy,
    task: { workProductRequirements: weaker },
  };

  assert.equal(
    resolveWorkProductRequirements(profile).requirementSetId,
    requirements.requirementSetId
  );
});

test("acceptance validation rejects a missing dependency", () => {
  assert.throws(
    () =>
      validateResultAcceptanceManifest(manifest(), requirements, [
        artifact("body", 20, "pions.result-body.utf8.v1", ["missing"]),
        artifacts[1]!,
        artifacts[2]!,
      ]),
    { name: "ResultAcceptanceManifestError", reason: "artifact_not_found" }
  );
});
