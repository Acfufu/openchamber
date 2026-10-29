# Model picker list

## Ownership

`ModelPickerList` is the searchable model list every model picker draws: the
composer's model menu, the multi-run model chooser and the agent model
selector in Settings. It owns the rows (Auto, the leading action, Favorites,
Recent, one section per provider), keyboard navigation from the search field,
the details card, starring, collapsing and reordering. Callers own the menu
around it, the footer's text and what a pick does.

## Invariants

- The list is one virtual list. Every row, section captions included, is an
  entry of `rows`; only rows near the view are mounted, whatever the number of
  providers or models.
- The highlight lives in `IndexSelectionStore`, outside React state: a key
  press re-renders the two rows whose highlight changed, never the list.
- Focus stays in the search field. The field names the highlighted row through
  `aria-activedescendant`, and points at nothing while that row is unmounted.
  Rows of one section sit in a `role="group"` named after it.
- Recent leaves out models Favorites already lists. Provider sections always
  list every model of the provider.
- At rest a row shows its logo where the section does not say the provider,
  its name, its context size and a set star. An empty star, the section
  chevron of an open section and the effort a row would run with appear on
  hover or highlight.

## Decisions

### Why one virtual list and not a virtualizer per long section

Sections used to virtualize on their own past 40 models and render shorter
ones whole, so ten providers of 30 models mounted 300 rows on every open.
With captions as rows, one virtualizer covers the whole list. The sticky
caption is an overlay that names the section of the top row, because a
`position: sticky` caption cannot stick inside absolutely placed rows.

### Why the virtualizer's view is capped at the window

The menu's first layout comes before its positioner sets the room it has
(`--available-height`), so the scroller is briefly as tall as every row and
the virtualizer would mount all of them. Capping the observed height at the
window keeps that first frame to a screenful. The first render already holds
that screenful (`initialRect` at the window height): rows mounted one commit
after the popup read to the popup's height morph as a content change, and the
menu opened tall and eased down to its size. Opening a 471-model list went
from about 300 ms to about 60 ms in the dev build with this and the change
above.

### Why one details card and not a tooltip per row

A tooltip per row kept a tooltip root mounted for every row while at most one
card shows. `ModelPickerRowCard` follows the highlighted row and anchors to it
(`TooltipContent anchor`).

### Why the whole row drags and not a grip

Grips on every favorite and provider caption were noise at rest. The row or
caption itself is the drag handle: a mouse drag starts after 8 px, so a click
still picks or folds, and a touch drag after a 250 ms press, so a swipe still
scrolls. dnd-kit's attributes are left off the row, because they would replace
its `option` role. While a provider is dragged every provider folds to its
caption, so the captions are what moves, and a copy of the dragged caption
follows the pointer from `document.body`: inside the menu's transformed popup
a fixed element lands off the pointer.
