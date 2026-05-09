/**
 * Static course → lesson manifest used by the progress summary endpoint to
 * compute completion percentages. Mirrors prof-content-engine/sidebars.ts —
 * if that file changes, update this one. Lesson IDs match Docusaurus
 * `metadata.id` (the slug stored in LessonProgress.lessonId).
 *
 * Practice / Writing are excluded — they're not "courses" with completion
 * semantics. Add later if needed.
 */

export interface CourseDef {
  id: string;
  label: string;
  track: 'AI for Engineering' | 'AI for Leaders' | 'Practice';
  lessons: readonly string[];
}

export const COURSES: readonly CourseDef[] = [
  {
    id: 'ai-for-leaders/genai-for-everyone',
    label: 'AI for Everyone — Gen AI & use cases',
    track: 'AI for Leaders',
    lessons: [
      'ai-for-leaders/genai-for-everyone/intro',
      'ai-for-leaders/genai-for-everyone/literacy-and-the-road-to-generative-ai',
      'ai-for-leaders/genai-for-everyone/five-layer-ai-stack',
      'ai-for-leaders/genai-for-everyone/ai-model-lifecycle-for-leaders',
      'ai-for-leaders/genai-for-everyone/llm-design-case-study',
    ],
  },
  {
    id: 'ai-for-leaders/prompt-engineering',
    label: 'Prompt Engineering',
    track: 'AI for Leaders',
    lessons: [
      'ai-for-leaders/prompt-engineering/introduction',
      'ai-for-leaders/prompt-engineering/design-of-a-prompt',
      'ai-for-leaders/prompt-engineering/language-models-are-few-shot-learners',
      'ai-for-leaders/prompt-engineering/hallucinations-in-large-language-models',
      'ai-for-leaders/prompt-engineering/hands-on-prompt-design-webapp-cursor',
      'ai-for-leaders/prompt-engineering/building-digital-assets-tutorial',
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
    id: 'ai-for-engineering/deep-computer-vision-cnn',
    label: 'Deep Computer Vision (CNN)',
    track: 'AI for Engineering',
    lessons: [
      'ai-for-engineering/deep-computer-vision-cnn/visual-revolution',
      'ai-for-engineering/deep-computer-vision-cnn/transformative-deep-learning-vision',
      'ai-for-engineering/deep-computer-vision-cnn/from-pixels-to-perception',
      'ai-for-engineering/deep-computer-vision-cnn/feature-detection-hierarchy',
      'ai-for-engineering/deep-computer-vision-cnn/learning-features-from-data',
      'ai-for-engineering/deep-computer-vision-cnn/preserving-spatial-structure-cnns',
      'ai-for-engineering/deep-computer-vision-cnn/filters-features-convolutions',
      'ai-for-engineering/deep-computer-vision-cnn/learning-to-see-cnns',
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
    id: 'ai-for-engineering/mle-interview',
    label: 'MLE Interview',
    track: 'AI for Engineering',
    lessons: [
      'ai-for-engineering/mle-interview/intro',
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
  {
    id: 'practice',
    label: 'ML Coding Problems',
    track: 'Practice',
    lessons: [
      'practice/softmax-from-scratch',
      'practice/scaled-dot-product-attention',
      'practice/bpe-apply-merges',
      'practice/top-p-sampling',
      'practice/cross-entropy-gradient',
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
