# Stitch Prompt For EIK

Use this as the starting prompt in Google Stitch.

```md
Design a responsive web app for a youth football coach called **EIK**. This is a 7v7 lineup planner and live match operations tool, not a generic admin dashboard.

The user is a coach of 10-year-olds who needs to create a fair three-period match plan, adjust the lineup visually, and handle live match events on the sideline from a phone.

Overall vibe: tactical sideline, premium sports operations, grounded and confident, dark pitch-inspired surfaces, warm clay and amber accents, subtle glassmorphism, strong hierarchy, touch-friendly controls, expressive typography, monospaced micro-labels, and a field-board visual language.

Avoid: generic SaaS dashboards, betting UI, fantasy sports aesthetics, childish cartoons, neon cyberpunk, and sterile enterprise admin patterns.

**DESIGN SYSTEM (REQUIRED):**
- Platform: Responsive web app, mobile-first with a strong desktop layout
- Breakpoints: prioritize 390px mobile and 1440px desktop
- Palette:
  - Canvas Deep Pine `#0c180f`
  - Surface Pitch `#17311c`
  - Surface Glass `rgba(255,255,255,0.05)`
  - Primary Accent Clay `#d47d33`
  - Primary Accent Gold `#fbbf24`
  - Secondary Accent Moss `#97c364`
  - Text Primary `#f5f2e9`
  - Text Secondary `#d6d3d1`
  - Text Muted `#78716c`
- Role accents:
  - Defense uses cool cyan/sky tones
  - Midfield uses emerald tones
  - Attack uses warm clay/rose tones
  - Goalkeeper uses amber/gold
  - Bench uses muted stone
- Typography:
  - bold athletic grotesk-style display headings
  - readable sans-serif body text
  - monospace for labels, timers, and metadata
- Shapes:
  - softly rounded large cards
  - pill-shaped CTAs
  - tactile tiles on the pitch board
- Elevation:
  - soft floating cards
  - subtle inset highlights
  - restrained shadows

**PAGE STRUCTURE:**
1. **Top Header / Hero**
   - headline explaining that the coach can plan goalkeeper, outfield roles, and substitutions without locking kids into the same roles
   - short supporting text about fairness, goalkeeper rotation, and planned substitutions
   - premium sports-control look, not a marketing landing page

2. **Pre-match Setup Panel**
   - large roster textarea for 8 to 12 player names
   - quick-fill chips for sample roster sizes
   - selectors for:
     - match format: 3 x 15 or 3 x 20
     - formation: 2-3-1 or 3-2-1
     - substitutions per period: 2, 3, or 4
     - goalkeeper for period 1, 2, and 3, with Auto option
   - primary CTA: Generate lineup
   - secondary CTA: Share via WhatsApp
   - non-blocking recommendation banner if bench waits may become long
   - validation / error state area

3. **Match Overview + Period Timer**
   - summary chips for goalkeepers, formation, players, substitutions, and total match time
   - a standout timer card with:
     - large live clock
     - remaining time
     - period selector for 1, 2, 3
     - segmented progress bar mapped to substitution windows
     - start, pause, resume, and reset buttons
   - current status badge: ready, running, paused, or finished

4. **Live Match Operations Panel**
   - show active period, active substitution window, and current minute
   - small panel for upcoming substitutions
   - small panel for available bench players who can come in now
   - central live formation board with player cards on a stylized pitch
   - each player card should expose quick live actions:
     - temporarily out
     - position swap
     - open action menu
   - a list of unavailable players with a one-tap return-to-play flow
   - a recommendation panel showing best replacement options, with one clearly marked as recommended and a short human-readable reason
   - confirmation action should clearly say the rest of the match is recalculated after confirmation

5. **Three Period Boards**
   - create one card for each period
   - each card includes:
     - goalkeeper name headline
     - starting bench summary
     - drag-and-drop tactical board on a pitch
     - lock/unlock controls on player slots
     - substitution windows below the board
   - active period should be visually highlighted
   - completed and upcoming states should be distinct but subtle

6. **Player Minutes Audit Section**
   - card grid of player summaries
   - for each player show:
     - total minutes
     - goalkeeper minutes
     - outfield minutes
     - bench minutes
     - positions and role groups played
   - expandable detailed view with per-period and per-substitution-window breakdown
   - this section should feel analytical and trustworthy, but still part of the same sports design system

**KEY UX REQUIREMENTS:**
- mobile-first and thumb-friendly for sideline use
- desktop should feel like a tactical coaching workstation
- drag-and-drop pitch interactions should feel obvious and tactile
- recommended live substitutions should be easy to understand
- locked positions must be visually unmistakable
- fairness data must be readable, not buried

**SCREEN OUTPUT REQUEST:**
Generate a cohesive multi-screen concept for:
- pre-match planning
- live match control
- player minutes audit

Show how the same design system scales from mobile to desktop. Keep the field board as the visual centerpiece of the product.
```
