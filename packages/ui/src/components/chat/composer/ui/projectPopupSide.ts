/** Room under the project trigger, in px, below which the project popup opens upward. */
const PROJECT_POPUP_MIN_ROOM_BELOW = 240;

/**
 * The project popup opens downward unless the trigger sits low, as in Mini
 * Chat, and there is more room above it. `bounds` is the main area the popup
 * is kept inside, clipped to the window by the caller.
 */
export const chooseProjectPopupSide = (
    trigger: { top: number; bottom: number },
    bounds: { top: number; bottom: number },
): 'top' | 'bottom' => {
    const roomBelow = bounds.bottom - trigger.bottom;
    const roomAbove = trigger.top - bounds.top;
    return roomBelow < PROJECT_POPUP_MIN_ROOM_BELOW && roomAbove > roomBelow ? 'top' : 'bottom';
};
