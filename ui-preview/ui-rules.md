# Alfred UI consistency rules

This local UI follows the requested 4px spacing grid:

- Layout spacing uses 4px increments: 4, 8, 12, 16, 20, 24, 32 and upward.
- Keep 1px borders and 2px focus outlines; these are strokes, not layout spacing.
- Use the existing system font throughout. Standard text is 14px/20px, metadata
  12px/16px, card titles 16px/24px, section titles 20px/28px and page titles
  32px/40px. Larger balance figures have their own 4px line-height rhythm.
- Use 400 for prose, 500 for labels and 600 for headings/actions. Keep figures
  tabular. Mobile inputs use 16px to avoid iOS zoom on focus.
- Interactive controls have at least a 44px touch target. The insight button and
  its replacement input both occupy the same 56px slot.
- Use Alfred's teal accent for primary actions, links, selected navigation and
  focus. Red identifies expenses and green identifies income. Bot artwork and
  category/chart hues retain their separate identity.
- Keep mobile controls compact and accessible. The narrow dock uses 11px labels
  below 360px, with slightly tighter tracking so every full destination fits;
  other visible interface text stays at least 12px.
- Preserve native scrolling and clearance beneath the floating navigation.
- Chart geometry, intrinsic image proportions and hairline strokes are exempt
  from spacing quantisation. Keep the table/card arrangement responsive.
