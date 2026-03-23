# EIK Design System

## Product Summary

EIK is a client-side 7v7 youth football lineup planner for coaches.

The product helps a coach:
- enter a roster of 8 to 12 players
- choose match format, formation, and substitution cadence
- assign or auto-pick one goalkeeper per period
- generate a fair three-period match plan
- manually adjust the starting board with drag and drop
- run a live match timer during a period
- handle live events such as a player being temporarily out, returning, or swapping position
- inspect detailed player minutes, bench time, goalkeeper time, and roles
- share the current state through a URL or WhatsApp

The app is lightweight by design:
- no login
- no backend
- no database
- no team management system
- all logic runs in the browser

## Users

Primary user:
- a youth football coach managing one match in real time

Secondary users:
- assistant coaches
- parents receiving a shared link

## Product Principles

- Fairness should be visible, not hidden in the algorithm.
- The interface should feel like a match operations board, not a generic SaaS dashboard.
- Live controls must be touch-friendly and usable on the sideline.
- Goalkeeper time counts as real playing time and should be communicated explicitly.
- Rotation and pedagogy matter as much as raw minutes.

## Core Screens

### 1. Pre-match Planner

Purpose:
- collect roster and match setup
- generate the initial plan

Required sections:
- hero/header
- roster textarea with quick-fill helpers
- match format selector
- formation selector
- substitutions-per-period selector
- goalkeeper selectors for period 1, 2, and 3
- generate CTA
- share CTA
- non-blocking recommendation banner when long bench waits are likely
- inline validation and error states

### 2. Match Overview

Purpose:
- summarize the generated plan
- surface high-level match settings and fairness metadata

Required content:
- seed
- score
- formation
- number of players
- substitution cadence
- total match duration
- selected goalkeepers

### 3. Period Timer

Purpose:
- run a live clock for the selected period
- show progress through current substitution windows

Required content:
- current clock
- remaining time
- status badge: idle, running, paused, finished
- period selector
- progress bar segmented by substitution windows
- start, pause, resume, reset controls

### 4. Live Match Operations

Purpose:
- support real-time coaching decisions while the match is active

Required content:
- active period and active substitution window
- upcoming substitutions
- currently available bench players
- live formation board
- quick actions on each player card:
  - temporarily out
  - position swap
  - open action menu
- unavailable players area with quick return flow
- recommendation list with a clear "recommended" row
- confirmation action that explains the rest of the match will be recalculated

### 5. Period Boards

Purpose:
- show each period as a tactical board
- allow manual lineup adjustments before or during review

Required content:
- one card per period
- goalkeeper headline
- starting bench summary
- draggable player tiles on the pitch
- lock / unlock per slot
- substitution windows below the board
- active/completed/upcoming visual states

### 6. Player Minutes Audit

Purpose:
- make fairness legible player by player

Required content:
- total minutes
- goalkeeper minutes
- outfield minutes
- bench minutes
- roles and positions played
- expandable per-period and per-window details

## Information Architecture

Desktop:
- top split layout for hero + setup panel
- overview and timer beneath
- live operations in a highlighted full-width band when a period is running
- three period cards in a responsive grid
- player minutes section below

Mobile:
- stacked layout
- setup first
- overview and timer second
- live operations directly below timer
- period cards as vertical sequence
- persistent floating live timer at the bottom while a period is active

## Visual Direction

Theme name:
- Tactical Sideline

Mood:
- confident
- sporty
- grounded
- tactical
- warm rather than neon

Avoid:
- generic B2B dashboards
- fantasy sports or betting aesthetics
- childish cartoon sports graphics
- glossy iOS health-app vibes

## Color System

Use semantic roles more than decorative colors.

Core palette:
- Canvas Deep Pine: `#0c180f`
- Surface Pitch: `#17311c`
- Surface Glass: `rgba(255,255,255,0.05)`
- Primary Accent Clay: `#d47d33`
- Primary Accent Gold: `#fbbf24`
- Secondary Accent Moss: `#97c364`
- Text Primary: `#f5f2e9`
- Text Secondary: `#d6d3d1`
- Text Muted: `#78716c`

Role accents:
- Defense: cool sky/cyan
- Midfield: emerald/green
- Attack: clay/rose warmth
- Goalkeeper: amber/gold
- Bench: muted stone
- Error: muted red
- Warning: amber
- Success: emerald

## Typography

Suggested type roles:
- Display headings: bold, compressed or athletic grotesk feel
- Body: readable sans-serif
- Micro labels and metadata: monospace

If Stitch supports custom references, bias toward:
- display style similar to Bricolage Grotesque
- body style similar to IBM Plex Sans
- mono style similar to IBM Plex Mono

## Geometry And Surfaces

- Large cards with softly rounded corners
- Pill buttons for primary actions
- Glassmorphism only as a supporting layer, not the whole aesthetic
- Pitch boards should feel tactile and field-like
- Use thin translucent borders plus soft inset highlights
- Preserve strong card separation between planning, live control, and audit surfaces

## Motion

- Subtle timer progress animation
- Smooth state change between upcoming, active, and completed chunks
- Gentle emphasis when a recommendation becomes active
- Drag-and-drop interactions should feel direct and tactical, not playful

## Interaction Rules

- All primary live controls must be thumb reachable on mobile
- Drag targets must be large and obvious
- Locked slots need unmistakable visual treatment
- Recommended replacement choices should explain why they are recommended
- Critical live confirmation must be one tap after selection, not hidden in a deep modal flow

## Domain Constraints

- 3 periods only
- 15 or 20 minutes per period
- formations: 2-3-1 and 3-2-1
- 2, 3, or 4 substitution windows per period
- goalkeeper is outside the outfield formation
- roster size between 8 and 12 unique players
- shared links must reflect current generated state, manual overrides, and live events

## Content Tone

- Swedish labels in product UI
- direct and coach-friendly copy
- avoid corporate jargon
- explain fairness and substitutions in plain language

## Stitch Guidance

When generating screens for this project:
- design a responsive web app
- prioritize mobile sideline use without losing desktop clarity
- treat the product as a match control interface plus fairness audit
- keep the field board central and visually memorable
- preserve the sports-tactics identity while improving hierarchy and polish
