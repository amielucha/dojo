import axios from "axios";
import { CookieJar } from "tough-cookie";
import { wrapper } from 'axios-cookiejar-support';
import fs from "fs";
import Path from "path";
import { mkdirp } from "mkdirp";
import { RateLimit } from "async-sema";
import dotenv from "dotenv";
import { fileURLToPath } from 'url';
import { ExifTool } from 'exiftool-vendored';
import { format } from 'date-fns';

dotenv.config();
const exiftool = new ExifTool();

const __dirname = Path.dirname(fileURLToPath(import.meta.url));

const cookieJar = new CookieJar();
const client = wrapper(axios.create({ jar: cookieJar, withCredentials: true }));

const LOGIN_URL = "https://home.classdojo.com/api/session";
const FEED_BASE_URL = "https://home.classdojo.com/api/storyFeed?includePrivate=true";

const IMAGE_DIR = "images";
const VIDEO_DIR = "videos";
const MAX_FEEDS = 30;
const CONCURRENCY = 15;
const LIMITER = RateLimit(CONCURRENCY);
const MAX_CONSECUTIVE_DUPLICATES = 12;

// Duplicate detection state
let consecutiveDuplicates = 0;
let processAborted = false;

async function main() {
    try {
        await login();
    } catch (error) {
        console.error("Failed to login to ClassDojo, double check your .env file", error);
        process.exit();
    }

    const parentId = process.env.PARENT;
    if (!parentId) {
        throw new Error('PARENT not set in .env');
    }

    let studentIds = await fetchAllStudents(parentId);
    if (studentIds.length === 0) {
        console.error('No students found for parent. Exiting.');
        process.exit(1);
    }
    console.log(`Processing feeds for ${studentIds.length} student(s): ${studentIds.join(', ')}`);

    for (const studentId of studentIds) {
        if (processAborted) {
            console.log(`\nSkipping remaining students - process aborted due to consecutive duplicates`);
            break;
        }
        console.log(`\n=== Processing student: ${studentId} ===`);
        await processStudentFeeds(studentId);
    }
    
    if (processAborted) {
        console.log(`\n📊 PROCESS SUMMARY:`);
        console.log(`Process was aborted after detecting ${MAX_CONSECUTIVE_DUPLICATES} consecutive duplicate files.`);
        console.log(`This indicates that all remaining files have likely already been downloaded.`);
        console.log(`Total consecutive duplicates detected: ${consecutiveDuplicates}`);
    } else {
        console.log(`\n✅ Process completed successfully for all students.`);
    }
}

async function processStudentFeeds(studentId) {
    let feedsProcessed = 0;
    
    while (feedsProcessed < MAX_FEEDS && !processAborted) {
        const studentFeedUrl = `${FEED_BASE_URL}&studentId=${studentId}`;
        
        console.log(`Processing feed ${feedsProcessed + 1}/${MAX_FEEDS} for student ${studentId}...`);
        try {
            await processFeed(studentFeedUrl, studentId);
        } catch (error) {
            console.error(`Couldn't process feed for student ${studentId}`, error);
            break; // Stop processing this student if there's an error
        }
        feedsProcessed++;
    }
    
    if (processAborted) {
        console.log(`Stopped processing feeds for student ${studentId} - process aborted due to consecutive duplicates`);
    } else {
        console.log(`Completed processing ${feedsProcessed} feeds for student ${studentId}`);
    }
}

async function login() {
    checkEnv("DOJO_EMAIL");
    checkEnv("DOJO_PASSWORD");

    function checkEnv(variable) {
        if (!process.env[variable]) {
            throw new Error(`${variable} not set in the .env file. Please follow the instructions on the README of the project.`);
        }
    }

    return await client.post(LOGIN_URL, {
        login: process.env.DOJO_EMAIL,
        password: process.env.DOJO_PASSWORD,
        resumeAddClassFlow: false
    });
}

async function getFeed(url) {
    const storyFeed = await client.get(url);
    return storyFeed.data;
}

async function processFeed(url, studentId) {
    // Check if process has been aborted
    if (processAborted) {
        console.log(`Skipping feed processing for student ${studentId} - process aborted due to consecutive duplicates`);
        return;
    }

    const feed = await getFeed(url);

    console.log(`found ${feed._items.length} feed items...`);

    for (const item of feed._items) {
        // Check if process has been aborted before processing each item
        if (processAborted) {
            console.log(`Stopping feed item processing - process aborted due to consecutive duplicates`);
            break;
        }

        const time = item.time;
        const date = time.split("T")[0];
        const datetime = new Date(time);
        const exifDate = format(datetime, "yyyy:MM:dd HH:mm:ss");

        console.log(exifDate)

        const contents = item.contents;
        const attachments = contents.attachments;

        if (attachments === undefined || attachments.length == 0) {
            // No files to download
            continue;
        }

        // TODO: what if we don't have studentId?
        await createDirectory(Path.resolve(__dirname, IMAGE_DIR, studentId, date));

        for (const attachment of attachments) {
            // Check if process has been aborted before processing each attachment
            if (processAborted) {
                console.log(`Stopping attachment processing - process aborted due to consecutive duplicates`);
                break;
            }

            const url = attachment.path;
            // Extract filename from URL, removing query parameters
            const urlPath = url.split('?')[0]; // Remove query parameters
            const baseFilename = urlPath.substring(urlPath.lastIndexOf("/") + 1);
            const filename = getFilePath(date, baseFilename, studentId);

            await LIMITER();
            downloadFileIfNotExists(url, filename, exifDate);
        }
    }

    console.log("-----------------------------------------------------------------------");
    console.log(`finished processing feed for student ${studentId}`);
    console.log("-----------------------------------------------------------------------");
    
    // Only process previous link if process hasn't been aborted
    if (!processAborted && feed._links && feed._links.prev && feed._links.prev.href) {
        const previousLink = feed._links.prev.href;
        console.log(`found previous link ${previousLink}`);

        try {
            await processFeed(previousLink, studentId);
        } catch (error) {
            console.error("Couldn't get feed", error);
        }
    } else if (processAborted) {
        console.log(`Skipping previous link processing - process aborted due to consecutive duplicates`);
    }
}

async function createDirectory(path) {
    try {
        await mkdirp(path);
        return Promise.resolve();
    } catch (error) {
        return Promise.reject(error);
    }
}

async function downloadFileIfNotExists(url, filePath, exifDate) {
    // Check if process has been aborted due to too many consecutive duplicates
    if (processAborted) {
        console.log(`Skipping ${filePath} - process aborted due to ${MAX_CONSECUTIVE_DUPLICATES} consecutive duplicates`);
        return;
    }

    const exists = await fileExists(filePath);
    console.log(`file ${filePath} exists = ${exists}`);
    
    if (!exists) {
        try {
            await downloadFile(url, filePath, exifDate);
            // Reset duplicate counter when a new file is successfully downloaded
            consecutiveDuplicates = 0;
        } catch (error) {
            console.error("Failed to download file ", url);
        }
    } else {
        // File already exists - increment duplicate counter
        consecutiveDuplicates++;
        console.log(`Duplicate file detected. Consecutive duplicates: ${consecutiveDuplicates}/${MAX_CONSECUTIVE_DUPLICATES}`);
        
        // Check if we've hit the limit
        if (consecutiveDuplicates >= MAX_CONSECUTIVE_DUPLICATES) {
            processAborted = true;
            console.log(`\n🚨 PROCESS ABORTED 🚨`);
            console.log(`Detected ${MAX_CONSECUTIVE_DUPLICATES} consecutive duplicate files.`);
            console.log(`This likely means all remaining files have already been downloaded.`);
            console.log(`Stopping the download process to avoid unnecessary API calls.`);
            console.log(`\nTo resume downloading, you can delete some of the most recent files and run the script again.`);
            console.log(`\nProcess aborted at: ${new Date().toISOString()}`);
        }
    }
}

async function fileExists(filePath) {
    return new Promise((resolve, reject) => {
        try {
            fs.accessSync(filePath, fs.constants.R_OK | fs.constants.W_OK);
            resolve(true);
        } catch (err) {
            resolve(false);
        }
    });
}

function getFilePath(date, filename, studentId) {
    return Path.resolve(__dirname, IMAGE_DIR, studentId, date, filename);
}

async function downloadFile(url, filePath, exifDate) {
    console.log(`about to download ${filePath}...`)
    const writer = fs.createWriteStream(filePath);

    const response = await client.get(url, {
        responseType: "stream"
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on("finish", async () => {
            console.log(`finished downloading ${filePath}`);

            try {
                await exiftool.write(filePath, { DateTimeOriginal: exifDate });
                console.log(`EXIF capture date added to ${filePath}`);
            } catch (error) {
                console.error(`Error adding EXIF capture date to ${filePath}`, error);
                reject(error);
                return;
            }


            resolve();
        });
        writer.on("error", reject);
    });
}

async function fetchStudentInfo(studentId) {
    try {
        const url = `https://home.classdojo.com/api/students/${studentId}`;
        const response = await client.get(url);
        console.log(`Student info for ${studentId}:`, response.data);
        return response.data;
    } catch (error) {
        console.error(`Failed to fetch student info for ${studentId}:`, error.response ? error.response.data : error.message);
        return null;
    }
}

async function fetchAllStudents(parentId) {
    const url = `https://home.classdojo.com/api/parent/${parentId}/student`;
    try {
        const response = await client.get(url);
        const students = response.data._items;
        if (!Array.isArray(students)) {
            console.error('Unexpected response for students:', response.data);
            return [];
        }
        console.log(`\n=== Students for parent ${parentId} ===`);
        students.forEach((student, idx) => {
            console.log(`\n#${idx + 1}`);
            console.log('ID:        ', student._id);
            console.log('Name:      ', (student.firstName || '') + ' ' + (student.lastName || ''));
            if (student.avatar) console.log('Avatar:    ', student.avatar);
            if (student.schoolName) console.log('School:    ', student.schoolName);
            if (student.loginUrl) console.log('Login URL: ', student.loginUrl);
            if (student.shortLoginUrl) console.log('Short URL: ', student.shortLoginUrl);
            // Print any other interesting fields
        });
        return students.map(s => s._id);
    } catch (error) {
        console.error('Failed to fetch students:', error.response ? error.response.data : error.message);
        return [];
    }
}

main();
