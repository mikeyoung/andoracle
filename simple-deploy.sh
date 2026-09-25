#!/bin/bash

# Simple automated deployment script for arpy project
echo "Starting simple automated deployment..."

# Stage all changes first (this should work)
echo "Staging all changes..."
git add .

# Commit changes with descriptive message  
echo "Committing changes..."
git commit -m "Fresh build and dependency update"

# Try to push changes (if branch exists)
echo "Pushing to remote repository..."
git push origin main

echo "Simple deployment completed!"