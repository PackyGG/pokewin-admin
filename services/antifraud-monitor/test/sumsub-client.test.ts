import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import Fastify from "fastify";

import { serviceRequestAuthorized } from "../src/auth.js";
import type { Config } from "../src/config.js";
import { SumsubClient } from "../src/sumsub-client.js";
import { registerSumsubRoutes } from "../src/sumsub-routes.js";

const applicantId = "64d2f8a091e8b70001a2b3c4";
const token = "prd:admin-read-token";
const secretKey = "sumsub-secret";
const fixedNow = new Date("2026-07-30T00:00:00.000Z");

function responseFor(path: string): unknown {
  if (path.endsWith("/one")) {
    return {
      id: applicantId,
      info: {
        firstName: "Must not leave the monitor",
        dob: "1990-01-01",
        country: "GBR",
        nationality: "GBR",
        countryOfBirth: "CZE",
        idDocs: [{ number: "secret-document-number" }],
      },
      fixedInfo: { country: "GBR", email: "private@example.com" },
      review: {
        reviewStatus: "completed",
        reviewDate: "2026-07-29 19:15:48+0000",
        levelName: "id-and-liveness",
        attemptCnt: 1,
        reviewResult: { reviewAnswer: "GREEN" },
      },
    };
  }
  if (path.endsWith("/requiredIdDocsStatus")) {
    return {
      IDENTITY: {
        country: "GBR",
        idDocType: "PASSPORT",
        imageIds: ["private-image-id"],
        reviewResult: { reviewAnswer: "GREEN" },
      },
      SELFIE: {
        idDocType: "SELFIE",
        imageIds: ["private-selfie-id"],
        reviewResult: { reviewAnswer: "GREEN" },
      },
    };
  }
  if (path.endsWith("/review/history")) {
    return {
      items: [
        {
          attemptId: "attempt-1",
          levelName: "id-and-liveness",
          reviewDate: "2026-07-29 19:15:48+0000",
          reviewStatus: "completed",
          reviewResult: {
            reviewAnswer: "GREEN",
            clientComment: "private compliance note",
          },
        },
      ],
      totalItems: 1,
    };
  }
  throw new Error(`Unexpected Sumsub path: ${path}`);
}

function clientFixture() {
  const requests: Array<{ path: string; headers: Headers }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input
          : input.url,
    );
    requests.push({ path: `${url.pathname}${url.search}`, headers: new Headers(init?.headers) });
    return Response.json(responseFor(url.pathname));
  };
  return {
    requests,
    client: new SumsubClient({
      token,
      secretKey,
      fetchImpl,
      now: () => fixedNow,
    }),
  };
}

test("Sumsub reads are signed and return only the sanitized review contract", async () => {
  const { client, requests } = clientFixture();
  const review = await client.getApplicantReview(applicantId);

  assert.equal(review.applicantCountry, "GBR");
  assert.equal(review.nationality, "GBR");
  assert.equal(review.countryOfBirth, "CZE");
  assert.deepEqual(review.documents, [
    {
      step: "IDENTITY",
      country: "GBR",
      documentType: "PASSPORT",
      reviewAnswer: "GREEN",
    },
    {
      step: "SELFIE",
      country: null,
      documentType: "SELFIE",
      reviewAnswer: "GREEN",
    },
  ]);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    const timestamp = String(Math.floor(fixedNow.getTime() / 1_000));
    const expectedSignature = createHmac("sha256", secretKey)
      .update(`${timestamp}GET${request.path}`)
      .digest("hex");
    assert.equal(request.headers.get("x-app-token"), token);
    assert.equal(request.headers.get("x-app-access-ts"), timestamp);
    assert.equal(request.headers.get("x-app-access-sig"), expectedSignature);
  }

  const serialized = JSON.stringify(review);
  for (const forbidden of [
    "firstName",
    "dob",
    "email",
    "number",
    "imageIds",
    "clientComment",
    "private",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, "i"));
  }

  await client.getApplicantReview(applicantId);
  assert.equal(requests.length, 3, "the five-minute cache should prevent refetching");
});

test("the Sumsub route is admin-token-only and rejects arbitrary applicant ids", async () => {
  const config = {
    API_TOKEN: "read-token-that-is-at-least-32-characters",
    API_ADMIN_TOKEN: "admin-token-that-is-at-least-32-characters",
  } as Pick<Config, "API_TOKEN" | "API_ADMIN_TOKEN">;
  const path = `/v1/kyc/applicants/${applicantId}/review`;
  assert.equal(
    serviceRequestAuthorized("GET", path, config.API_TOKEN, config),
    false,
  );
  assert.equal(
    serviceRequestAuthorized("GET", path, config.API_ADMIN_TOKEN, config),
    true,
  );

  const { client } = clientFixture();
  const app = Fastify();
  await registerSumsubRoutes(app, client);
  const invalid = await app.inject({
    method: "GET",
    url: "/v1/kyc/applicants/not-an-applicant/review",
  });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.json(), { error: "invalid_request" });
  await app.close();
});

test("the Sumsub route returns sanitized live data and fails closed when unconfigured", async () => {
  const fixture = clientFixture();
  const app = Fastify();
  await registerSumsubRoutes(app, fixture.client);
  const response = await app.inject({
    method: "GET",
    url: `/v1/kyc/applicants/${applicantId}/review`,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.applicantCountry, "GBR");
  await app.close();

  const unavailable = Fastify();
  await registerSumsubRoutes(unavailable, null);
  const unavailableResponse = await unavailable.inject({
    method: "GET",
    url: `/v1/kyc/applicants/${applicantId}/review`,
  });
  assert.equal(unavailableResponse.statusCode, 503);
  assert.deepEqual(unavailableResponse.json(), {
    error: "sumsub_not_configured",
  });
  await unavailable.close();
});
