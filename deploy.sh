#!/bin/bash

# Automated deployment script for arpy project
echo "Starting automated deployment..."

# Update dependencies
echo "Updating dependencies..."
npm install --upgrade

# Clean and build the project  
echo "Building project..."
npm run build

# Stage all changes
echo "Staging changes..."
git add .

# Commit changes with descriptive message
echo "Committing changes..."
git commit -m "Fresh build and dependency update"

# Push to remote repository
echo "Pushing to origin..."
git push origin bionic/main

echo "Deployment completed successfully!"