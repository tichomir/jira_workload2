export * from './types';
export { EmailDetector } from './EmailDetector';
export { ApiKeySecretDetector } from './ApiKeySecretDetector';
export { CreditCardDetector } from './CreditCardDetector';
export { PhoneDetector } from './PhoneDetector';

import { Detector } from './types';
import { EmailDetector } from './EmailDetector';
import { ApiKeySecretDetector } from './ApiKeySecretDetector';
import { CreditCardDetector } from './CreditCardDetector';
import { PhoneDetector } from './PhoneDetector';

/**
 * All registered detectors in the order they should be applied.
 * Callers iterate this array and invoke detect() on each.
 */
export const ALL_DETECTORS: readonly Detector[] = [
  new EmailDetector(),
  new ApiKeySecretDetector(),
  new CreditCardDetector(),
  new PhoneDetector(),
];
