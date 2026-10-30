---
name: write-monthly-report
description: Author and locally verify an AIWatch monthly reliability report using its data, recurrence checks, bilingual content rules, and publication gates.
metadata:
  short-description: Write an AIWatch monthly report
---

# Codex monthly report authoring

Use this skill when editing the sibling `aiwatch-reports` Jekyll report. Work on a
`report/YYYY-MM` branch, keep `published: false`, and read the target archive plus the previous two
or three reports. Fill Summary, Korean mirror, Recommendations, Key Insight, Notable Incidents,
Observations, and the manual NVD attribution check from the report's own data; do not invent numbers.
Use the generated service count/category header as the source of truth, include specialized
recommendation rows only for ranked services in buckets present that month, and avoid repeating the
same story or timeless framing across sections. Keep Score notation bare and Korean prose native.

Delete every AUTO-DRAFT and RECURRENCE CHECK fence before publishing. Run the report's lint and test
checks, serve drafts with Jekyll using `--unpublished`, and obtain the user's explicit in-browser
confirmation. Only then may the user-approved commit, PR, merge, or publication happen. Use
`exec_command` for commands and `apply_patch` for edits; never flip `published` or publish on your
own authority.
