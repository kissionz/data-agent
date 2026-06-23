# InsightFlow ChatBI Design System

## Overview

InsightFlow is a high-density enterprise analysis workspace used in bright office environments, often for long sessions and shared review. The interface uses a restrained light theme, familiar product controls, crisp hierarchy, and one blue accent. Design variance is 3/10, motion intensity is 2/10, and visual density is 8/10.

## Color

- Brand: `#146EF5`
- Ink: `#101828`
- Secondary text: `#475467`
- Canvas: `#F7F9FC`
- Raised surface: `#FFFFFF`
- Border: `#E4E9F0`
- Success: `#16A05D`
- Warning: `#F59E0B`
- Danger: `#E5484D`

Brand blue is reserved for primary actions, selection, links, and active run states. Status colors always pair color with an icon and label.

## Typography

Use `Inter, SF Pro Text, PingFang SC, Microsoft YaHei, system-ui, sans-serif`. Page titles are 24/32 semibold, section titles 16/24 semibold, body copy 14/22 regular, metadata 12/18 regular, and KPI values 28/36 semibold. Data uses tabular numerals.

## Layout

At 1440px and above, use `68px 260px minmax(720px, 1fr) 235px`. Below 1440px the context panel becomes a drawer; below 1280px the session list also becomes a drawer; below 768px the app uses a 52px top bar, one-column content, and a fixed composer.

## Shape and Spacing

Use an 8px spacing grid, with 4px only for icon-label micro spacing. Controls use 8px radii, small labels 6px, and panels 10px. Avoid pills and nested card stacks. Borders organize the shell; shadows are limited to popovers, drawers, and dialogs.

## Components

- Global rail: icon-only navigation with tooltips and one selected surface.
- Session list: grouped rows, inline status, search, and a single primary new-session action.
- Timeline: user question, run stage, clarification, result, evidence, and follow-up in one chronological flow.
- Result: conclusion first, then KPI/chart/table, assumptions, evidence, and feedback.
- Context panel: domain, mode, time, metrics, dimensions, filters, semantic version, and source.
- Composer: fixed to the main workspace bottom; changes from submit to stop while active.
- Governance pages: compact toolbars, tables, inspectors, version history, and explicit lifecycle actions.

## Motion

Motion only communicates state. Hover and focus use 120-160ms; drawers and state transitions use 180-240ms with `cubic-bezier(.16,1,.3,1)`. Reduced-motion mode removes transforms and looping indicators.

## Accessibility

Target WCAG 2.2 AA. All icon buttons require names and tooltips. Keyboard focus is always visible. Charts have adjacent tabular data. Status is never color-only. Touch targets are at least 44px, even when the visible icon is smaller.
