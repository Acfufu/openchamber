import { describe, expect, test } from 'bun:test';
import { chooseProjectPopupSide } from './projectPopupSide';

describe('chooseProjectPopupSide', () => {
    test('opens upward from a trigger near the bottom of the window, as in Mini Chat', () => {
        // Mini Chat: a 760px window with the picker 122px above its bottom.
        expect(chooseProjectPopupSide({ top: 610, bottom: 638 }, { top: 0, bottom: 760 })).toBe('top');
    });

    test('opens downward when there is room below the trigger', () => {
        // The main window's centered draft.
        expect(chooseProjectPopupSide({ top: 277, bottom: 305 }, { top: 0, bottom: 740 })).toBe('bottom');
    });

    test('stays downward when the room above is smaller still', () => {
        expect(chooseProjectPopupSide({ top: 100, bottom: 128 }, { top: 0, bottom: 300 })).toBe('bottom');
    });
});
