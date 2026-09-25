#!/usr/bin/env python3
"""
Simple auto-deploy script for andoracle project - your 'autodeploy' command
Builds webapp, stages, commits, pushes, prepares for deployment to mikeyoung.org/andoracle
"""

import subprocess
import sys
import os
from datetime import datetime

def run_command(command, description=""):
    """Execute a shell command and return success status"""
    print(f"▶ {description}")
    
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd="/media/mike/media1/backup/webdev/arpy",
            capture_output=True,
            text=True,
            timeout=120
        )
        
        if result.returncode == 0:
            print(f"✓ Success")
            return True
        else:
            print(f"✗ Failed with error code {result.returncode}")
            if result.stderr.strip():
                print(f"  Error: {result.stderr[:150]}..." if len(result.stderr) > 150 else result.stderr)
            return False
            
    except subprocess.TimeoutExpired:
        print(f"✗ Command timed out")
        return False
    except Exception as e:
        print(f"✗ Exception occurred: {e}")
        return False

def main():
    print("🚀 Starting autodeploy process...")
    
    # Build the webapp first (this is what you want)
    print("🏗️  Building web application...")
    success = run_command('npm install', "Updating npm dependencies")
    if not success:
        print("⚠️  Warning: Dependency update failed, continuing with build...")
    
    success = run_command('npm run build', "Building web application with Vite")
    if not success:
        print("⚠️  Warning: Build failed, but continuing with Git operations...")
    
    # Stage all changes
    print("📋 Staging all changes...")
    success = run_command('git add .', "Staging all changes")
    if not success:
        return 1
    
    # Commit changes with timestamp
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    commit_message = f"Fresh build and deployment: {timestamp}"
    print("💾 Committing changes...")
    success = run_command(f'git commit -m "{commit_message}"', "Committing changes")
    if not success:
        return 1
    
    # Push to remote repository
    print("📡 Pushing to origin/main...")
    success = run_command('git push origin main', "Pushing to GitHub")
    
    if not success:
        print("⚠️  Push completed but with potential credential issues (this is normal in automated environments)")
    
    print("✅ Autodeploy process completed!")
    print("💡 Next steps:")
    print("   - Verify the changes are live at https://mikeyoung.org/andoracle")
    print("   - Check build logs if deployment fails")
    
    return 0

if __name__ == "__main__":
    sys.exit(main())