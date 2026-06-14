@echo off
setlocal enabledelayedexpansion

:: ── Bump patch version in package.json ───────────────────────────────────────
for /f "tokens=* usebackq" %%A in (`node -e "const p=require('./package.json');const v=p.version.split('.');v[2]=parseInt(v[2])+1;console.log(v.join('.'))"`) do set NEW_VER=%%A

echo Bumping version to %NEW_VER%

:: Update package.json
node -e "const fs=require('fs');const p=require('./package.json');p.version='%NEW_VER%';fs.writeFileSync('./package.json',JSON.stringify(p,null,2)+'\n')"

:: Update io-package.json
node -e "const fs=require('fs');const p=require('./io-package.json');const old=p.common.version;p.common.version='%NEW_VER%';const news={};news['%NEW_VER%']={'en':'Version %NEW_VER%'};p.common.news=Object.assign(news,p.common.news);fs.writeFileSync('./io-package.json',JSON.stringify(p,null,2)+'\n')"

:: ── Git commit, tag and push ──────────────────────────────────────────────────
git add package.json io-package.json
git commit -m "v%NEW_VER%"
git tag v%NEW_VER%
git push
git push origin v%NEW_VER%

echo Done – v%NEW_VER% pushed to GitHub.
