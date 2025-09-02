# Dojo

### Purpose
This is a script that retrieves ClassDojo images since they don't offer a feature to download images from your story feed.

### Run instructions
1. Create a `.env` file in the root of your project that has the following (with curly braces omitted):
```
DOJO_EMAIL={YOUR_EMAIL_THAT_YOU_USE_TO_LOGIN_TO_CLASSDOJO}
DOJO_PASSWORD={YOUR_PASSWORD_THAT_YOU_USE_TO_LOGIN_TO_CLASSDOJO}
PARENT={YOUR_PARENT_ID}
```

**Note:** The `PARENT` environment variable is required and should contain your parent account's ID. You can find this ID in the ClassDojo URLs or API responses when logged in as a parent.

2. `npm install`

3. `npm start`

When you run the script, it will:
- Log in to ClassDojo using your credentials
- Fetch all students for the parent account
- Display all available info for each student (ID, name, avatar, school, login URLs, etc)
- Download and organize all images and videos for each student in an `images/` directory, organized by student ID and date.