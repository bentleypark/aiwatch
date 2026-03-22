#!/bin/bash
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [[ -z "$FILE" ]]; then
  exit 0
fi

# Frontend JS/JSX files → ESLint
if [[ "$FILE" =~ src/.*\.(js|jsx)$ ]]; then
  npx eslint "$FILE" 2>&1 | head -20 || true
fi

# Worker TS files → TypeScript check (only errors in edited file)
if [[ "$FILE" =~ worker/.*\.ts$ ]]; then
  BASENAME=$(basename "$FILE")
  npx tsc --noEmit --skipLibCheck --project worker/tsconfig.json 2>&1 | grep "$BASENAME" | head -20 || true
fi

exit 0
