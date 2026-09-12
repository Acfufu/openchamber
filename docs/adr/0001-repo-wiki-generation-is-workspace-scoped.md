# Repo Wiki generation is workspace-scoped; cross-project wiki surfaces are read-only

---
status: accepted
---

Repo Wiki generation (generate, stop, retry) only ever targets the active
workspace directory (decided 2026-09-13). Cross-project surfaces — the rail
panel's project switcher, the future mobile read-only tab — can read any
stored wiki but expose no enabled generation controls for a non-active
project. The switcher's disabled Generate control is deliberate; the
manifest deliberately does not record a source directory that would enable
cross-project generation.

## Considered Options

ZCode's shape: a full-page wiki surface listing every opened project, each
generatable; per the maintainer's ZCode orphan-worker bug report, ZCode
additionally batch-generates across repositories in one action.

## Consequences

A second surface rendering run state doubles the correctness area before
anyone has asked for full-page reading — the rail panel is resizable and
already carries the full markdown pipeline. Batch generation needs a source
directory in the manifest, orchestration UI, and cross-project failure
aggregation for an unproven need; long-lived background job fleets are the
failure mode (worker orphans) that in-process fire-and-forget generation
avoids by construction. Multi-project-first usage proven — the mobile
read-only tab shipping, or real user feedback — reopens the full-page view
and batch generation together.

