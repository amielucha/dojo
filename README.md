# Dojo

### Purpose
This is a script that retrieves classdojo images since they don't offer a feature to download images from your story feed.

### Run instructions
1. Create a `.env` file in the root of your project that has the following (with curly braces omitted):
```
DOJO_EMAIL={YOUR_EMAIL_THAT_YOU_USE_TO_LOGIN_TO_CLASSDOJO}
DOJO_PASSWORD={YOUR_PASSWORD_THAT_YOU_USE_TO_LOGIN_TO_CLASSDOJO}
STUDENTS={STUDENT_ID_1,STUDENT_ID_2,STUDENT_ID_3}
```

**Note:** The `STUDENTS` environment variable is required and should contain comma-separated student IDs. You can find these IDs in the ClassDojo URLs when viewing a student's profile.

Example:
```
STUDENTS=627e5f7dbf4237ce230773a3,65956aabda9951efb1d0706a
```

2. `npm install`

3. `npm start`

Any assets that are scraped will go in an `images/` directory, organized by student ID and date.