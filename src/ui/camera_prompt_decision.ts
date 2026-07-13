// Pure, host-agnostic decision logic for the first-run camera-mode prompt (issue
// #1727). No DOM and no imports: it takes primitive inputs and returns the policy,
// so a Vitest can pin "when do we show it" and "what does each choice set" directly.
// The DOM modal (camera_prompt.ts) is the thin consumer that reads the live touch
// state plus the localStorage flag, then renders and applies through these helpers.

export type CameraModeChoice = 'classic' | 'mouse';

// Mouse Camera is the recommended default (issue #1727): most newcomers prefer
// modern mouse-driven camera controls, so it is the pre-selected option and the
// value confirming with no change applies.
export const RECOMMENDED_CAMERA_CHOICE: CameraModeChoice = 'mouse';

export interface CameraPromptContext {
  // The on-screen touch/joystick interface is active (a phone, or a device forced
  // to touch): the mouse-camera choice is irrelevant there, so the prompt is
  // suppressed.
  touchControlsActive: boolean;
  // The prompt has already been answered or dismissed in this browser (localStorage
  // flag), so it must never appear again.
  alreadyShown: boolean;
}

/** Whether the first-run camera prompt should be shown for this player. */
export function shouldShowCameraPrompt(ctx: CameraPromptContext): boolean {
  return !ctx.touchControlsActive && !ctx.alreadyShown;
}

/**
 * The mouseCamera setting value a given choice applies: Mouse Camera turns it on,
 * Classic Camera turns it off. Mirrors the Esc, Key Bindings toggle exactly.
 */
export function cameraChoiceEnablesMouseCamera(choice: CameraModeChoice): boolean {
  return choice === 'mouse';
}
