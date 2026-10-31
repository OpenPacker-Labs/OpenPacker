@ECHO off
REM pnpm inside opm run (ADR 0061): runs a script through opm run, refuses the rest.
SETLOCAL
SET "_OPM_NODE=%npm_node_execpath%"
IF "%_OPM_NODE%"=="" SET "_OPM_NODE=node"
"%_OPM_NODE%" "%~dp0..\..\dist\shims\pnpm.js" %*
