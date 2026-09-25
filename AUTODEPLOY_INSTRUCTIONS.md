# Autodeploy Instructions

## What "Autodeploy" Means

When you say "**autodeploy**" in this project, it means to run the `autodeploy-store.py` script.

## Script Location
```bash
/media/mike/media1/backup/webdev/arpy/autodeploy-store.py
```

## What the Script Does
1. **Builds the main web application** with Vite
2. **Builds browser store artifacts** (Firefox add-on and Chrome extension)
3. **Updates npm dependencies**
4. **Stages all changes automatically**
5. **Commits with timestamp message**
6. **Pushes to GitHub**

## How to Run
```bash
cd /media/mike/media1/backup/webdev/arpy
python3 autodeploy-store.py
```

## Requirements
- Python 3 installed
- Node.js 20.19+ or 22.12+ (you have v24.21.0)
- Git configured
- Proper permissions for file operations

## Purpose
This script automates the complete deployment workflow:
- Fresh build of webapp
- Current store packages (browser extensions)  
- Stage, commit, push all changes
- Prepare for deployment to mikeyoung.org/andoracle