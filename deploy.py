#!/usr/bin/env python3

import subprocess
import sys
import os

def run_command(command, description):
    print(f"\n--- {description} ---")
    try:
        result = subprocess.run(
            command, 
            shell=True, 
            check=True, 
            capture_output=True, 
            text=True,
            cwd=os.getcwd()
        )
        print("✓ Success")
        if result.stdout.strip():
            print(result.stdout[:200] + "..." if len(result.stdout) > 200 else result.stdout)
        return True
    except subprocess.CalledProcessError as e:
        print(f"✗ Error: {e}")
        if e.stderr.strip():
            print("Error output:", e.stderr[:200] + "..." if len(e.stderr) > 200 else e.stderr)
        return False

def main():
    print("Starting automated deployment...")
    
    # Check if we're in the right directory
    current_dir = os.getcwd()
    print(f"Working in: {current_dir}")
    
    # Update dependencies (using pip for Python packages)
    deps_updated = run_command('pip install --upgrade -r requirements.txt', 'Updating Python dependencies')
    
    # Clean build
    clean_done = run_command('make clean', 'Cleaning build directory')
    
    # Build the project
    build_done = run_command('make build', 'Building project')
    
    # Stage changes
    stage_done = run_command('git add .', 'Staging changes')
    
    # Commit changes
    commit_done = run_command('git commit -m "Fresh build and dependency update"', 'Committing changes')
    
    # Push changes (note: we need to make sure git remote is set up)
    push_done = run_command('git push origin bionic/main', 'Pushing to remote repository')
    
    if deps_updated and clean_done and build_done and stage_done and commit_done:
        print("\n🎉 Deployment completed successfully!")
        return True
    else:
        print("\n❌ Some steps failed during deployment.")
        return False

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)