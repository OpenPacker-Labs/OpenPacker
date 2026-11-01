@echo off
rem The opm CLI from this working tree, rebuilt on demand.
rem
rem Windows has no cheap `find -newer`, so this asks turbo every time rather
rem than checking staleness first. A warm cache hit is ~0.4s. Set
rem OPENPACKER_DEV_NO_BUILD=1 to skip it.
setlocal
set "OPENPACKER_REPO=%~dp0..\.."
if not "%OPENPACKER_DEV_NO_BUILD%"=="1" (
  pushd "%OPENPACKER_REPO%"
  call npx turbo run build --filter=@openpacker/cli... >nul 2>&1
  if errorlevel 1 (
    echo opm: build failed, refusing to run a stale binary. 1>&2
    echo opm: run `npm run build` in %OPENPACKER_REPO% to see the error. 1>&2
    popd
    exit /b 1
  )
  popd
)
node "%OPENPACKER_REPO%\apps\opm\dist\opm.js" %*
