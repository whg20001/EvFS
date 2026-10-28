import type { AiTask } from '@sanxing/contracts';
import { planLearningInput as plan } from '@sanxing/learning-domain';
import { fitsLearningRequest, inspectLearningRequest, type LearningRequestOptions } from '@sanxing/learning-agent';
export const planLearningInput = <T extends AiTask>(input: T, options: LearningRequestOptions) => plan(input, options, { fitsLearningRequest, inspectLearningRequest });
