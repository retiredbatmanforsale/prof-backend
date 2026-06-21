import { Prisma, QuestionKind } from "@prisma/client";
import type { AssessmentQuestion } from "@prisma/client";
import type { QuestionInput } from "../schemas/assessment.js";

/**
 * Serialization + mapping helpers for the assessment engine. The key
 * invariant: answer keys (correctIndex / correctIndexes) are stored on CUSTOM
 * questions but MUST NOT reach students. `serializeQuestionForStudent` strips
 * them; the faculty serializer keeps them so authors can review.
 *
 * Evaluation/grading is out of scope for this slice — these helpers only shape
 * what each audience can read.
 */

const ANSWER_KEY_FIELDS = ["correctIndex", "correctIndexes"] as const;

function contentObject(content: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return content as Record<string, unknown>;
  }
  return content === null ? null : { value: content };
}

/** Full question, answer keys included — faculty/author view. */
export function serializeQuestionForFaculty(q: AssessmentQuestion) {
  return {
    id: q.id,
    order: q.order,
    kind: q.kind,
    points: q.points,
    catalogSlug: q.catalogSlug,
    title: q.title,
    content: q.content,
  };
}

/** Question with answer keys removed — student view. */
export function serializeQuestionForStudent(q: AssessmentQuestion) {
  const obj = contentObject(q.content);
  let safeContent: unknown = obj;
  if (obj) {
    const clone: Record<string, unknown> = { ...obj };
    for (const field of ANSWER_KEY_FIELDS) delete clone[field];
    safeContent = clone;
  }
  return {
    id: q.id,
    order: q.order,
    kind: q.kind,
    points: q.points,
    catalogSlug: q.catalogSlug,
    title: q.title,
    content: safeContent,
  };
}

/**
 * Map a validated question input to the nested-create row for
 * prisma.assessmentQuestion. `order` is the 0-based position in the submitted
 * list. CATALOG keeps catalogSlug + snapshot; CUSTOM stores the body in content.
 */
/**
 * Pick the assessment metadata / rule fields from a validated body into a
 * Prisma data object. Only includes keys that were provided (so PATCH leaves
 * omitted fields untouched). Shared by faculty + campus-admin handlers.
 */
export function metadataData(body: {
  track?: "DSA" | "AIML" | "MIXED";
  attemptPolicy?: "UNLIMITED" | "SINGLE" | "NONE";
  lateEntryAllowed?: boolean;
  shuffleQuestions?: boolean;
  navigationMode?: "FREE" | "SEQUENTIAL";
  autoSubmit?: boolean;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (body.track !== undefined) out.track = body.track;
  if (body.attemptPolicy !== undefined) out.attemptPolicy = body.attemptPolicy;
  if (body.lateEntryAllowed !== undefined) out.lateEntryAllowed = body.lateEntryAllowed;
  if (body.shuffleQuestions !== undefined) out.shuffleQuestions = body.shuffleQuestions;
  if (body.navigationMode !== undefined) out.navigationMode = body.navigationMode;
  if (body.autoSubmit !== undefined) out.autoSubmit = body.autoSubmit;
  return out;
}

export function questionCreateData(input: QuestionInput, order: number) {
  if (input.kind === "CATALOG") {
    return {
      order,
      kind: QuestionKind.CATALOG,
      points: input.points ?? null,
      catalogSlug: input.catalogSlug,
      title: input.title ?? null,
      content: (input.content ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    };
  }
  return {
    order,
    kind: QuestionKind.CUSTOM,
    points: input.points ?? null,
    catalogSlug: null,
    title: input.title ?? null,
    content: input.content as Prisma.InputJsonValue,
  };
}
