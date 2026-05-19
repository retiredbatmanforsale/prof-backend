/**
 * Static course → lesson manifest used by the progress summary endpoint to
 * compute completion percentages. Source of truth is
 * `prof-frontend/lib/courses/sidebar.ts`; if that file changes, update
 * this one to match. Lesson IDs match the frontend's velite slug
 * (the value stored in LessonProgress.lessonId).
 *
 * Practice problems are excluded — they have their own progress
 * surface and don't fit the "course with N sequential lessons" shape.
 * Intro pages are excluded so progress reads "completed 3 of 7 real
 * lessons" rather than inflating the total with a course splash.
 */

export interface CourseDef {
  id: string;
  label: string;
  track: 'AI for Engineering';
  lessons: readonly string[];
}

export const COURSES: readonly CourseDef[] = [
  {
    id: 'ai-for-engineering/foundations-of-regression',
    label: 'Foundations of Regression',
    track: 'AI for Engineering',
    lessons: [
      'ai-for-engineering/foundations-of-regression/linear-regression-line-ssr-gradient-descent',
      'ai-for-engineering/foundations-of-regression/why-logistic-regression',
      'ai-for-engineering/foundations-of-regression/sigmoid-function-logistic-regression',
      'ai-for-engineering/foundations-of-regression/logistic-regression-decision-boundaries',
      'ai-for-engineering/foundations-of-regression/intuition-behind-logistic-regression',
      'ai-for-engineering/foundations-of-regression/log-likelihood-instead-of-squared-error',
      'ai-for-engineering/foundations-of-regression/interview-readiness',
    ],
  },
  {
    id: 'ai-for-engineering/deep-neural-networks',
    label: 'Deep Neural Networks',
    track: 'AI for Engineering',
    lessons: [
      'ai-for-engineering/deep-neural-networks/perceptron-and-neuron',
      'ai-for-engineering/deep-neural-networks/layers-in-deep-neural-networks',
      'ai-for-engineering/deep-neural-networks/activation-functions',
      'ai-for-engineering/deep-neural-networks/loss-functions',
      'ai-for-engineering/deep-neural-networks/forward-pass',
      'ai-for-engineering/deep-neural-networks/backward-pass',
      'ai-for-engineering/deep-neural-networks/trainable-parameters-and-hyperparameters',
      'ai-for-engineering/deep-neural-networks/overfitting-in-neural-networks',
      'ai-for-engineering/deep-neural-networks/neural-network-architecture',
      'ai-for-engineering/deep-neural-networks/neural-network-from-scratch',
      'ai-for-engineering/deep-neural-networks/interview-readiness',
    ],
  },
  {
    id: 'ai-for-engineering/deep-computer-vision-cnn',
    label: 'Deep Computer Vision (CNN)',
    track: 'AI for Engineering',
    lessons: [
      'ai-for-engineering/deep-computer-vision-cnn/visual-revolution',
      'ai-for-engineering/deep-computer-vision-cnn/transformative-deep-learning-vision',
      'ai-for-engineering/deep-computer-vision-cnn/from-pixels-to-perception',
      'ai-for-engineering/deep-computer-vision-cnn/feature-detection-hierarchy',
      'ai-for-engineering/deep-computer-vision-cnn/preserving-spatial-structure-cnns',
      'ai-for-engineering/deep-computer-vision-cnn/filters-features-convolutions',
      'ai-for-engineering/deep-computer-vision-cnn/learning-to-see-cnns',
      'ai-for-engineering/deep-computer-vision-cnn/cnn-architectures-applications',
      'ai-for-engineering/deep-computer-vision-cnn/implement-cnn-from-scratch',
      'ai-for-engineering/deep-computer-vision-cnn/interview-readiness',
    ],
  },
  {
    id: 'ai-for-engineering/deep-sequence-modelling-rnn',
    label: 'Deep Sequence Modelling (RNN)',
    track: 'AI for Engineering',
    lessons: [
      'ai-for-engineering/deep-sequence-modelling-rnn/foundations-of-deep-sequence-modeling',
      'ai-for-engineering/deep-sequence-modelling-rnn/from-static-networks-to-time-aware',
      'ai-for-engineering/deep-sequence-modelling-rnn/rnn-internal-mechanics',
      'ai-for-engineering/deep-sequence-modelling-rnn/lstm-and-gru',
      'ai-for-engineering/deep-sequence-modelling-rnn/bringing-sequence-modeling-real-world',
      'ai-for-engineering/deep-sequence-modelling-rnn/training-rnn-backprop-through-time',
      'ai-for-engineering/deep-sequence-modelling-rnn/training-an-rnn-in-pytorch',
      'ai-for-engineering/deep-sequence-modelling-rnn/interview-readiness',
    ],
  },
  {
    id: 'ai-for-engineering/attention-is-all-you-need',
    label: 'Attention Is All You Need',
    track: 'AI for Engineering',
    lessons: [
      'ai-for-engineering/attention-is-all-you-need/problem-with-rnns-and-lstms',
      'ai-for-engineering/attention-is-all-you-need/positional-embeddings',
      'ai-for-engineering/attention-is-all-you-need/attention',
      'ai-for-engineering/attention-is-all-you-need/self-attention',
      'ai-for-engineering/attention-is-all-you-need/multi-headed-attention',
      'ai-for-engineering/attention-is-all-you-need/cross-attention',
      'ai-for-engineering/attention-is-all-you-need/encoder-stack',
      'ai-for-engineering/attention-is-all-you-need/encoder-decoder-transformer',
      'ai-for-engineering/attention-is-all-you-need/from-encoder-decoder-to-gpt',
      'ai-for-engineering/attention-is-all-you-need/interview-readiness',
    ],
  },
  {
    id: 'ai-for-engineering/build-and-train-your-own-gpt2-model',
    label: 'Build and Train Your Own GPT-2',
    track: 'AI for Engineering',
    lessons: [
      'ai-for-engineering/build-and-train-your-own-gpt2-model/problem-with-rnns-lstms',
      'ai-for-engineering/build-and-train-your-own-gpt2-model/token-embeddings',
      'ai-for-engineering/build-and-train-your-own-gpt2-model/positional-embeddings',
      'ai-for-engineering/build-and-train-your-own-gpt2-model/attention-multi-head-attention',
      'ai-for-engineering/build-and-train-your-own-gpt2-model/causal-masking',
      'ai-for-engineering/build-and-train-your-own-gpt2-model/residual-connections',
      'ai-for-engineering/build-and-train-your-own-gpt2-model/layer-normalization',
      'ai-for-engineering/build-and-train-your-own-gpt2-model/feed-forward-neural-networks',
      'ai-for-engineering/build-and-train-your-own-gpt2-model/generation-of-next-tokens',
      'ai-for-engineering/build-and-train-your-own-gpt2-model/decoder-only-transformer',
      'ai-for-engineering/build-and-train-your-own-gpt2-model/interview-readiness',
    ],
  },
  {
    id: 'ai-for-engineering/agentic-ai',
    label: 'Build a Multi-Agent Research Assistant',
    track: 'AI for Engineering',
    lessons: [
      'ai-for-engineering/agentic-ai/bare-llm-loop',
      'ai-for-engineering/agentic-ai/tool-use',
      'ai-for-engineering/agentic-ai/react-reasoning',
      'ai-for-engineering/agentic-ai/planner',
      'ai-for-engineering/agentic-ai/parallel-executors',
      'ai-for-engineering/agentic-ai/shared-memory',
      'ai-for-engineering/agentic-ai/critic',
      'ai-for-engineering/agentic-ai/full-system',
      'ai-for-engineering/agentic-ai/observability',
      'ai-for-engineering/agentic-ai/interview-readiness',
    ],
  },
  {
    id: 'ai-for-engineering/ml-system-design',
    label: 'ML System Design',
    track: 'AI for Engineering',
    lessons: [
      'ai-for-engineering/ml-system-design/the-ml-sd-interview',
      'ai-for-engineering/ml-system-design/recsys-define-the-problem',
      'ai-for-engineering/ml-system-design/recsys-data-pipeline',
      'ai-for-engineering/ml-system-design/recsys-retrieval-two-tower',
      'ai-for-engineering/ml-system-design/recsys-ranking',
      'ai-for-engineering/ml-system-design/recsys-online-serving',
      'ai-for-engineering/ml-system-design/recsys-evaluation-and-ab-testing',
      'ai-for-engineering/ml-system-design/recsys-monitoring-and-retraining',
      'ai-for-engineering/ml-system-design/rag-define-the-problem',
      'ai-for-engineering/ml-system-design/rag-retrieval-and-reranking',
      'ai-for-engineering/ml-system-design/rag-generation-and-serving',
      'ai-for-engineering/ml-system-design/rag-evaluation',
      'ai-for-engineering/ml-system-design/case-ad-ctr-prediction',
      'ai-for-engineering/ml-system-design/case-real-time-fraud-detection',
      'ai-for-engineering/ml-system-design/case-eta-prediction',
      'ai-for-engineering/ml-system-design/case-multimodal-search',
      'ai-for-engineering/ml-system-design/interview-readiness',
    ],
  },
  {
    id: 'ai-for-engineering/mle-interview',
    label: 'MLE Interview',
    track: 'AI for Engineering',
    lessons: [
      'ai-for-engineering/mle-interview/rubrics-and-playbook',
      'ai-for-engineering/mle-interview/guides/recently-asked',
      'ai-for-engineering/mle-interview/guides/meta/e3',
      'ai-for-engineering/mle-interview/guides/meta/e4',
      'ai-for-engineering/mle-interview/guides/meta/e5',
      'ai-for-engineering/mle-interview/guides/google/l3',
      'ai-for-engineering/mle-interview/guides/google/l4',
      'ai-for-engineering/mle-interview/guides/google/l5',
      'ai-for-engineering/mle-interview/guides/amazon/sde-i',
      'ai-for-engineering/mle-interview/guides/amazon/sde-ii',
      'ai-for-engineering/mle-interview/guides/amazon/sde-iii',
      'ai-for-engineering/mle-interview/guides/amazon/applied-scientist',
      'ai-for-engineering/mle-interview/guides/microsoft/l62',
      'ai-for-engineering/mle-interview/guides/microsoft/l63',
      'ai-for-engineering/mle-interview/guides/microsoft/l64',
      'ai-for-engineering/mle-interview/guides/microsoft/mle',
      'ai-for-engineering/mle-interview/guides/microsoft/applied-scientist',
      'ai-for-engineering/mle-interview/guides/microsoft/ml-research-engineer',
      'ai-for-engineering/mle-interview/guides/apple/ict2',
      'ai-for-engineering/mle-interview/guides/apple/ict3',
      'ai-for-engineering/mle-interview/guides/apple/ict4',
    ],
  },
] as const;

/** Total lesson count across all courses — used for the headline ring. */
export const TOTAL_LESSONS: number = COURSES.reduce(
  (sum, c) => sum + c.lessons.length,
  0
);

/** Flat set of all known lesson IDs — used to filter unknown legacy IDs. */
export const KNOWN_LESSON_IDS: ReadonlySet<string> = new Set(
  COURSES.flatMap((c) => c.lessons)
);
