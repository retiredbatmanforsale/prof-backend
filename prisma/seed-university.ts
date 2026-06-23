import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
const prisma = new PrismaClient();

// ──────────────────────────────────────────────────────────────────────────
// University runtime seed — fully idempotent.
//
// Every row is written with upsert, keyed either on a real unique constraint
// or on a stable explicit `id` (prefixed `seed-…`), so re-running NEVER
// duplicates. Lesson IDs come from src/lib/courseManifest.ts (the canonical
// velite slugs stored in LessonProgress.lessonId); practice slugs are real
// files in prof-frontend/data/practice/problems. This means seeded lesson +
// practice progress actually registers in the attendance / roadmap engines
// instead of pointing at dead ids.
//
// Coverage (so a fresh clone can demo the whole faculty + student runtime):
//   • 5 GradeComponents (Midsem AUTO-linked, Endsem/Viva/Project/Lab manual)
//   • 3 cohort-owned assessments (quiz / midsem / subjective) via sectionId
//   • Assessment attempts in all 3 states (graded-objective, pending-review,
//     graded → drives AUTO gradebook sync)
//   • LessonProgress: completed / partial / started across students
//   • PracticeAttempt: solved / attempted-unsolved across students
//   • Attendance parity: lesson + practice + assessment participation all
//     present and spread, so no faculty tab looks empty on a fresh seed.
// ──────────────────────────────────────────────────────────────────────────

const now = new Date();
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

// Canonical lesson IDs (subset) — see src/lib/courseManifest.ts.
const FOR = "ai-for-engineering/foundations-of-regression";
const DNN = "ai-for-engineering/deep-neural-networks";
const L = {
  for1: `${FOR}/linear-regression-line-ssr-gradient-descent`,
  for2: `${FOR}/why-logistic-regression`,
  for3: `${FOR}/sigmoid-function-logistic-regression`,
  for4: `${FOR}/logistic-regression-decision-boundaries`,
  dnn1: `${DNN}/perceptron-and-neuron`,
  dnn2: `${DNN}/layers-in-deep-neural-networks`,
};

// Real practice slugs (files in prof-frontend/data/practice/problems).
const P = {
  linreg: "linear-regression-gradient-descent",
  binlog: "binary-classific-ation-w-logistic-regression",
  logreg: "logistic-regression-w-gradient-descent",
  softmax: "softmax-multinomial-regression",
  poly: "sorted-polynomial-features",
};

async function main() {
  const facPw = await bcrypt.hash("faculty123", 12);
  const stuPw = await bcrypt.hash("student123", 12);
  const yr = new Date();
  yr.setFullYear(yr.getFullYear() + 1);

  const org = await prisma.organization.upsert({
    where: { slug: "prof-university" },
    update: {},
    create: { name: "Prof University", slug: "prof-university", emailDomains: ["prof.edu"], isActive: true, accessStartDate: new Date(), accessEndDate: yr },
  });

  // Faculty operator (campus-admin tier = the single university operator)
  const fac = await prisma.user.upsert({
    where: { email: "faculty@prof.edu" },
    update: { hashedPassword: facPw },
    create: { name: "Dr. Meera Iyer", email: "faculty@prof.edu", hashedPassword: facPw, emailVerified: new Date(), role: "USER" },
  });
  const facMember = await prisma.organizationMember.upsert({
    where: { userId_organizationId: { userId: fac.id, organizationId: org.id } },
    update: { isOrgAdmin: true, orgRole: "CAMPUS_ADMIN", isVerified: true, isActive: true },
    create: { userId: fac.id, organizationId: org.id, isVerified: true, isActive: true, isOrgAdmin: true, orgRole: "CAMPUS_ADMIN" },
  });

  const section = await prisma.section.upsert({
    where: { organizationId_name: { organizationId: org.id, name: "CSE-A · 2026" } },
    update: {},
    create: { organizationId: org.id, name: "CSE-A · 2026", course: "AI for Engineering" },
  });

  const students: [string, string, string][] = [
    ["Aarav Sharma", "student@prof.edu", "22BCS1043"],
    ["Priya Nair", "priya@prof.edu", "22BCS1051"],
    ["Rohan Mehta", "rohan@prof.edu", "22BCS1062"],
    ["Isha Verma", "isha@prof.edu", "22BCS1078"],
    ["Karthik Rao", "karthik@prof.edu", "22BCS1090"],
  ];
  const stu: { name: string; email: string; userId: string; memberId: string }[] = [];
  for (const [name, email] of students) {
    const u = await prisma.user.upsert({
      where: { email },
      update: { hashedPassword: stuPw },
      create: { name, email, hashedPassword: stuPw, emailVerified: new Date(), role: "USER" },
    });
    const m = await prisma.organizationMember.upsert({
      where: { userId_organizationId: { userId: u.id, organizationId: org.id } },
      update: { orgRole: "STUDENT", isVerified: true, isActive: true },
      create: { userId: u.id, organizationId: org.id, isVerified: true, isActive: true, orgRole: "STUDENT" },
    });
    await prisma.sectionStudent.upsert({
      where: { sectionId_organizationMemberId: { sectionId: section.id, organizationMemberId: m.id } },
      update: {},
      create: { sectionId: section.id, organizationMemberId: m.id },
    });
    stu.push({ name, email, userId: u.id, memberId: m.id });
  }

  // ── 2. Assessments (owned by the cohort via sectionId; no AssessmentAssignment) ──
  const baseAsmt = { organizationId: org.id, createdByMemberId: facMember.id, sectionId: section.id, status: "PUBLISHED" as const, visibility: "SECTION" as const, track: "MIXED" as const };

  const quiz = await prisma.assessment.upsert({
    where: { id: "seed-asmt-quiz" },
    update: { ...baseAsmt, title: "Quiz 1 · Regression Basics" },
    create: { id: "seed-asmt-quiz", ...baseAsmt, title: "Quiz 1 · Regression Basics", description: "Short objective quiz on linear & logistic regression.", attemptPolicy: "SINGLE", durationMinutes: 20, opensAt: daysAgo(10), dueAt: daysAgo(7) },
  });
  const midsem = await prisma.assessment.upsert({
    where: { id: "seed-asmt-midsem" },
    update: { ...baseAsmt, title: "Mid-Semester Exam" },
    create: { id: "seed-asmt-midsem", ...baseAsmt, title: "Mid-Semester Exam", description: "Objective mid-sem covering regression + DNN foundations.", attemptPolicy: "SINGLE", durationMinutes: 60, opensAt: daysAgo(6), dueAt: daysAgo(4) },
  });
  const subj = await prisma.assessment.upsert({
    where: { id: "seed-asmt-subj" },
    update: { ...baseAsmt, title: "End-Sem Subjective Exam" },
    create: { id: "seed-asmt-subj", ...baseAsmt, title: "End-Sem Subjective Exam", description: "Long-form subjective questions — manual review required.", attemptPolicy: "SINGLE", durationMinutes: 90, opensAt: daysAgo(2), dueAt: daysAgo(1) },
  });

  // Questions (stable ids; MCQ content carries an answer key, subjective does not).
  const mcq = (prompt: string, options: string[], correctIndex: number) => ({ type: "mcq", prompt, options, correctIndex });
  const free = (prompt: string) => ({ type: "subjective", prompt });
  const questions: [string, string, number, "CUSTOM", number, string, object][] = [
    ["seed-q-quiz-1", quiz.id, 0, "CUSTOM", 5, "Gradient descent minimises…", mcq("Gradient descent minimises which quantity in linear regression?", ["The sum of squared residuals", "The number of features", "The learning rate", "The bias term"], 0)],
    ["seed-q-quiz-2", quiz.id, 1, "CUSTOM", 5, "Logistic regression output", mcq("The sigmoid maps a logit to which range?", ["(-1, 1)", "(0, 1)", "[0, ∞)", "(-∞, ∞)"], 1)],
    ["seed-q-mid-1", midsem.id, 0, "CUSTOM", 10, "SSR vs MSE", mcq("SSR differs from MSE by which factor?", ["A constant 1/n", "A log term", "Nothing", "The sign"], 0)],
    ["seed-q-mid-2", midsem.id, 1, "CUSTOM", 10, "Decision boundary", mcq("A logistic regression decision boundary is…", ["Always non-linear", "Linear in feature space", "A single point", "Undefined"], 1)],
    ["seed-q-mid-3", midsem.id, 2, "CUSTOM", 10, "Perceptron", mcq("A perceptron computes…", ["A weighted sum + activation", "Only a sum", "A convolution", "A softmax"], 0)],
    ["seed-q-mid-4", midsem.id, 3, "CUSTOM", 10, "DNN layers", mcq("Stacking layers lets a network learn…", ["Linear maps only", "Hierarchical features", "Fewer parameters", "Nothing new"], 1)],
    ["seed-q-subj-1", subj.id, 0, "CUSTOM", 20, "Derive log-likelihood", free("Derive the log-likelihood loss for logistic regression and explain why it is preferred over squared error.")],
    ["seed-q-subj-2", subj.id, 1, "CUSTOM", 20, "Backprop essay", free("Explain backpropagation through a 2-layer network, including the role of the chain rule.")],
  ];
  for (const [id, assessmentId, order, kind, points, title, content] of questions) {
    await prisma.assessmentQuestion.upsert({
      where: { id },
      update: { assessmentId, order, kind, points, title, content },
      create: { id, assessmentId, order, kind, points, title, content },
    });
  }

  // ── 3. Assessment attempts (all three required states + parity spread) ──
  // [studentIndex, assessmentId, status, score, maxScore, submittedDaysAgo, graded, pendingReview]
  const attempts: [number, string, "SUBMITTED", number | null, number, number, boolean, boolean][] = [
    // one objective COMPLETED + graded (quiz)
    [0, quiz.id, "SUBMITTED", 8, 10, 7, true, false],
    [2, quiz.id, "SUBMITTED", 6, 10, 7, true, false],
    // graded midsem attempts (feed AUTO gradebook sync) — spread for attendance
    [0, midsem.id, "SUBMITTED", 34, 40, 4, true, false],
    [1, midsem.id, "SUBMITTED", 24, 40, 4, true, false],
    [2, midsem.id, "SUBMITTED", 30, 40, 4, true, false],
    [3, midsem.id, "SUBMITTED", 14, 40, 4, true, false],
    // one subjective PENDING REVIEW (auto portion 0, awaits faculty marks)
    [0, subj.id, "SUBMITTED", 0, 40, 1, false, true],
  ];
  for (const [si, assessmentId, status, score, maxScore, subDays, graded, pendingReview] of attempts) {
    const userId = stu[si].userId;
    const data = {
      status,
      score,
      maxScore,
      submittedAt: daysAgo(subDays),
      gradedAt: graded ? daysAgo(subDays) : null,
      pendingReview,
      remainingAttempts: 0,
      answers: { seeded: true },
    };
    await prisma.assessmentAttempt.upsert({
      where: { assessmentId_userId: { assessmentId, userId } },
      update: data,
      create: { assessmentId, userId, startedAt: daysAgo(subDays), ...data },
    });
  }

  // ── 1. Grade components (Midsem AUTO-linked; rest manual). Weights sum to 100. ──
  const components: [string, string, string, number, number, string | null][] = [
    // id, name, type, maxMarks, weight, assessmentId(AUTO) | null
    ["seed-gc-midsem", "Mid-Semester", "MIDSEM", 40, 20, midsem.id],
    ["seed-gc-endsem", "End-Semester", "ENDSEM", 100, 40, null],
    ["seed-gc-viva", "Viva", "VIVA", 20, 10, null],
    ["seed-gc-project", "Project", "PROJECT", 100, 20, null],
    ["seed-gc-lab", "Lab", "LAB", 50, 10, null],
  ];
  for (const [id, name, type, maxMarks, weight, assessmentId] of components) {
    await prisma.gradeComponent.upsert({
      where: { id },
      update: { sectionId: section.id, name, type, maxMarks, weight, assessmentId },
      create: { id, sectionId: section.id, name, type, maxMarks, weight, assessmentId },
    });
  }

  // AUTO entries for Midsem — pre-computed exactly as syncAssessmentGrades would
  // (scaled = score/maxScore × maxMarks; here maxScore == maxMarks so scaled == score),
  // so the gradebook is populated immediately AND a faculty "sync" is a no-op.
  const autoMidsem: [number, number][] = [[0, 34], [1, 24], [2, 30], [3, 14]];
  for (const [si, score] of autoMidsem) {
    await prisma.gradeEntry.upsert({
      where: { componentId_studentId: { componentId: "seed-gc-midsem", studentId: stu[si].userId } },
      update: { score, source: "AUTO", enteredByMemberId: null },
      create: { componentId: "seed-gc-midsem", studentId: stu[si].userId, score, source: "AUTO", enteredByMemberId: null },
    });
  }

  // MANUAL entries for Endsem / Viva / Project / Lab (faculty-entered).
  // rows: per student → [endsem(100), viva(20), project(100), lab(50)]
  const manualScores: Record<number, [number, number, number, number]> = {
    0: [86, 18, 90, 46],
    1: [64, 13, 72, 38],
    2: [78, 16, 84, 42],
    3: [41, 9, 55, 24],
    4: [70, 14, 68, 35],
  };
  const manualComps = ["seed-gc-endsem", "seed-gc-viva", "seed-gc-project", "seed-gc-lab"];
  for (const si of Object.keys(manualScores).map(Number)) {
    const row = manualScores[si];
    for (let c = 0; c < manualComps.length; c++) {
      await prisma.gradeEntry.upsert({
        where: { componentId_studentId: { componentId: manualComps[c], studentId: stu[si].userId } },
        update: { score: row[c], source: "MANUAL", enteredByMemberId: facMember.id },
        create: { componentId: manualComps[c], studentId: stu[si].userId, score: row[c], source: "MANUAL", enteredByMemberId: facMember.id },
      });
    }
  }

  // ── 4. Lesson progress: completed / partial / started across students ──
  type LState = "completed" | "partial" | "started";
  const lessonRows: [number, string, LState][] = [
    [0, L.for1, "completed"], [0, L.for2, "completed"], [0, L.for3, "completed"], [0, L.dnn1, "completed"], [0, L.for4, "partial"],
    [1, L.for1, "completed"], [1, L.for2, "completed"], [1, L.for3, "partial"], [1, L.for4, "started"],
    [2, L.for1, "completed"], [2, L.for2, "completed"], [2, L.for3, "completed"], [2, L.dnn1, "started"],
    [3, L.for1, "started"], [3, L.for2, "partial"],
    [4, L.for1, "completed"], [4, L.for2, "partial"], [4, L.for3, "started"],
  ];
  for (const [si, lessonId, state] of lessonRows) {
    const data =
      state === "completed"
        ? { status: "READ" as const, startedAt: daysAgo(5), completedAt: daysAgo(3), readAt: daysAgo(3), completionPercent: 100, timeSpentSeconds: 300, lastActiveAt: daysAgo(3) }
        : state === "partial"
        ? { status: "IN_PROGRESS" as const, startedAt: daysAgo(2), completedAt: null, readAt: null, completionPercent: 55, timeSpentSeconds: 140, lastActiveAt: daysAgo(1) }
        : { status: "IN_PROGRESS" as const, startedAt: daysAgo(1), completedAt: null, readAt: null, completionPercent: 10, timeSpentSeconds: 18, lastActiveAt: daysAgo(1) };
    await prisma.lessonProgress.upsert({
      where: { userId_lessonId: { userId: stu[si].userId, lessonId } },
      update: data,
      create: { userId: stu[si].userId, lessonId, ...data },
    });
  }

  // ── 5. Practice attempts: solved / attempted-unsolved across students ──
  type PState = "solved" | "attempted";
  const practiceRows: [number, string, PState, number][] = [
    [0, P.linreg, "solved", 2], [0, P.binlog, "solved", 1], [0, P.logreg, "attempted", 3],
    [1, P.linreg, "solved", 4], [1, P.binlog, "attempted", 2],
    [2, P.linreg, "solved", 1], [2, P.logreg, "solved", 2], [2, P.softmax, "attempted", 1],
    [3, P.linreg, "attempted", 1],
    [4, P.linreg, "solved", 3], [4, P.poly, "attempted", 2],
  ];
  for (const [si, problemSlug, state, n] of practiceRows) {
    const solved = state === "solved";
    const data = { attempts: n, solved, solvedAt: solved ? daysAgo(2) : null };
    await prisma.practiceAttempt.upsert({
      where: { userId_problemSlug: { userId: stu[si].userId, problemSlug } },
      update: data,
      create: { userId: stu[si].userId, problemSlug, ...data },
    });
  }

  // ── Summary ──
  const counts = {
    gradeComponents: await prisma.gradeComponent.count({ where: { sectionId: section.id } }),
    gradeEntries: await prisma.gradeEntry.count({ where: { component: { sectionId: section.id } } }),
    assessments: await prisma.assessment.count({ where: { sectionId: section.id } }),
    attempts: await prisma.assessmentAttempt.count({ where: { assessment: { sectionId: section.id } } }),
    lessonProgress: await prisma.lessonProgress.count({ where: { userId: { in: stu.map((s) => s.userId) } } }),
    practiceAttempts: await prisma.practiceAttempt.count({ where: { userId: { in: stu.map((s) => s.userId) } } }),
  };
  console.log("✓ faculty@prof.edu / faculty123 (campus-admin), student@prof.edu / student123");
  console.log("✓ Org 'Prof University', section 'CSE-A · 2026', 5 students");
  console.log("✓ Coverage:", counts);
}
main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
