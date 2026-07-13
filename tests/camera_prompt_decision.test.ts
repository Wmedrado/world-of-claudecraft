import { describe, expect, it } from 'vitest';
import {
  cameraChoiceEnablesMouseCamera,
  RECOMMENDED_CAMERA_CHOICE,
  shouldShowCameraPrompt,
} from '../src/ui/camera_prompt_decision';

describe('first-run camera prompt decision', () => {
  describe('shouldShowCameraPrompt', () => {
    it('shows on a fresh desktop browser (no touch, not yet shown)', () => {
      expect(shouldShowCameraPrompt({ touchControlsActive: false, alreadyShown: false })).toBe(
        true,
      );
    });

    it('is suppressed once already answered or dismissed in this browser', () => {
      expect(shouldShowCameraPrompt({ touchControlsActive: false, alreadyShown: true })).toBe(
        false,
      );
    });

    it('is suppressed on a touch-controls device even on first run', () => {
      expect(shouldShowCameraPrompt({ touchControlsActive: true, alreadyShown: false })).toBe(
        false,
      );
    });

    it('is suppressed when both touch and already-shown hold', () => {
      expect(shouldShowCameraPrompt({ touchControlsActive: true, alreadyShown: true })).toBe(false);
    });
  });

  describe('cameraChoiceEnablesMouseCamera', () => {
    it('Mouse Camera enables mouseCamera', () => {
      expect(cameraChoiceEnablesMouseCamera('mouse')).toBe(true);
    });

    it('Classic Camera disables mouseCamera', () => {
      expect(cameraChoiceEnablesMouseCamera('classic')).toBe(false);
    });
  });

  it('Mouse Camera is the recommended pre-selected choice', () => {
    expect(RECOMMENDED_CAMERA_CHOICE).toBe('mouse');
    // The recommended default must be the one that enables the modern scheme.
    expect(cameraChoiceEnablesMouseCamera(RECOMMENDED_CAMERA_CHOICE)).toBe(true);
  });
});
