#!/bin/bash

# Final automated deployment script for arpy project
echo "Starting FINAL automated deployment..."

# Stage all changes 
echo "Staging all changes..."
git add .

# Commit changes with descriptive message  
echo "Committing changes..."
git commit -m "Fresh build and dependency update"

# Push to remote repository (main branch, not bionic/main)
echo "Pushing to main branch..."
git push origin main

echo "Deployment completed successfully!"