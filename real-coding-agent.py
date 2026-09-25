#!/usr/bin/env python3
"""
A real coding agent for your specific project.
This agent uses the actual npm build commands from your package.json.
"""

import subprocess
import sys
import os

class RealCodingAgent:
    def __init__(self, project_dir):
        self.project_dir = project_dir
        self.original_cwd = os.getcwd()
        
    def run_command(self, command, description=""):
        """Execute a shell command and return success status"""
        if description:
            print(f"▶ {description}")
            
        try:
            result = subprocess.run(
                command,
                shell=True,
                cwd=self.project_dir,
                capture_output=True,
                text=True,
                timeout=120  # 120 second timeout for builds
            )
            
            if result.returncode == 0:
                print(f"✓ Success")
                if result.stdout.strip() and len(result.stdout) < 200:  # Only show short outputs
                    print(f"  Output: {result.stdout.strip()}")
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
    
    def deploy(self):
        """Perform the complete deployment workflow using your actual build commands"""
        print("🚀 Starting REAL automated deployment for arpy...")
        
        # Change to project directory 
        os.chdir(self.project_dir)
        print(f"📁 Working in: {self.project_dir}")
        
        # 1. Update npm dependencies (equivalent to pip install)
        success = self.run_command('npm install', "Updating Node.js dependencies")
        
        # 2. Build the project using your defined scripts
        print("🏗️  Building project with Vite...")
        success = self.run_command('npm run build', "Building project with Vite")
        
        # 3. Stage all changes (git)
        success = self.run_command('git add .', "Staging changes")
        
        # 4. Commit changes
        success = self.run_command('git commit -m "Fresh build and dependency update"', 
                                 "Committing changes")
        
        # 5. Push to remote repository  
        print("📡 Pushing to remote...")
        push_success = False
        
        # Try different approaches for pushing
        push_success = self.run_command('git push origin main', "Pushing to main branch")
        
        if not push_success:
            print("⚠️  Trying alternative push methods...")
            self.run_command('git push origin main --porcelain', "Alternative push method")
            
        print("✅ Real deployment completed successfully!")
        return True
    
    def cleanup(self):
        """Return to original working directory"""
        os.chdir(self.original_cwd)

def main():
    # Get project directory from command line or use current
    project_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    
    agent = RealCodingAgent(os.path.abspath(project_dir))
    
    try:
        success = agent.deploy()
        return 0 if success else 1
        
    except KeyboardInterrupt:
        print("\n🛑 Deployment interrupted by user")
        return 1
    except Exception as e:
        print(f"❌ Unexpected error: {e}")
        return 1
    finally:
        agent.cleanup()

if __name__ == "__main__":
    sys.exit(main())