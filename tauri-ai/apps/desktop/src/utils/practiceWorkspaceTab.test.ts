import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openOrFocusViewWindow } = vi.hoisted(() => ({
  openOrFocusViewWindow: vi.fn(),
}));

vi.mock('./viewWindow', () => ({
  openOrFocusViewWindow,
}));

import { PRACTICE_TAB_TITLE, PRACTICE_WINDOW_LABEL, openPracticeWindow } from './practiceWorkspaceTab';

describe('practiceWorkspaceTab', () => {
  beforeEach(() => {
    openOrFocusViewWindow.mockReset();
    openOrFocusViewWindow.mockResolvedValue({ label: PRACTICE_WINDOW_LABEL });
  });

  it('opens the dedicated practice window by default', async () => {
    await openPracticeWindow();

    expect(openOrFocusViewWindow).toHaveBeenCalledWith('practice', PRACTICE_TAB_TITLE, {
      label: PRACTICE_WINDOW_LABEL,
      noDefaultSession: true,
    });
  });
});
