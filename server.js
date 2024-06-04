const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');

const app = express();
const port = 3000;

// Serve static files from the "public" directory
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));

app.post('/login', async (req, res) => {
    const { name, password } = req.body;
    console.log('Received form data:', name, password);

    try {
        await automateGLSLogin(name, password);
        res.send('Login and data extraction successful.');
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('An error occurred during the login process.');
    }
});

async function automateGLSLogin(username, password) {
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null
    });
    const page = await browser.newPage();

    try {
        console.log('Navigating to the login page...');
        // Navigate to the login page
        await page.goto('https://atlas.gls-spain.es/Account/Login?ReturnUrl=%2F&Error=Sesi%C3%B3n%20expirada');

        console.log('Filling the login form...');
        // Fill in the login form
        await page.type('#username', username);
        await page.type('input[name="password"]', password);

        console.log('Submitting the login form...');
        // Wait for navigation after login
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            page.click('.btn.btn-primary') // Click the login button
        ]);

        console.log('Successfully logged in.');

        // Navigate to the desired page after successful login
        await page.goto('https://atlas.gls-spain.es/customer/index');

        // Wait until the body tag is present, indicating that the page has fully loaded
        await page.waitForSelector('body');

        // Wait for the spinner overlay to disappear
        await waitForSpinnerToDisappear(page);

        // Select 1000 records per page
        await selectRecordsPerPage(page, 1000);

        await page.waitForSelector('a[href="#tab_Web"]', { timeout: 60000 });

        // Click on the desired link
        await page.evaluate(() => {
            document.querySelector('a[href="#tab_Web"]').click();
        });

        // Wait for the spinner overlay to disappear
        await waitForSpinnerToDisappear(page);

        // Process each login entry in the table
        await processLogins(page);

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await browser.close();
    }
}

async function selectRecordsPerPage(page, value) {
    try {
        console.log(`Setting records per page to ${value}...`);
        await page.evaluate((value) => {
            const select = document.querySelector('#optionPaginator');
            select.value = value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }, value);
        // Wait for the page to reload after changing the page size
        await waitForSpinnerToDisappear(page);
    } catch (error) {
        console.error('Error selecting records per page:', error);
    }
}

async function processLogins(page) {
    try {
        // Fetch the total number of records
        const totalRecords = await page.evaluate(() => {
            const totalElement = document.querySelector('span[data-bind="text: my.vm.recordsTotal"]');
            return totalElement ? parseInt(totalElement.textContent, 10) : 0;
        });

        console.log(`Total records: ${totalRecords}`);

        for (let rowIndex = 0; rowIndex < totalRecords; rowIndex++) {
            try {
                // Re-fetch the rows to get the most recent references
                let rows = await page.$$('#table-customer-simple tbody tr');

                // If the current row is not loaded, scroll to load more rows
                while (rowIndex >= rows.length) {
                    await page.evaluate(() => {
                        window.scrollBy(0, window.innerHeight);
                    });
                    await delay(2000); // Wait a bit for new rows to load
                    rows = await page.$$('#table-customer-simple tbody tr'); // Re-fetch rows after scrolling
                }

                // Ensure the row exists before interacting with it
                if (rows[rowIndex]) {
                    await interactWithRow(page, rowIndex);
                } else {
                    console.error(`Row ${rowIndex} does not exist anymore.`);
                    break;
                }
            } catch (error) {
                console.error(`Error processing row ${rowIndex}:`, error);
                // Retry the current row if an error occurs
                await delay(1000); // Wait for a second before retrying
            }
        }
    } catch (error) {
        console.error('Error:', error);
    }
}

async function interactWithRow(page, rowIndex) {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(rowIndex);
            // Wait for the row to be present
            await page.waitForSelector(`tr[data-toggle="${rowIndex}"]`, { timeout: 60000 });
            
            // Click on the row using its data-toggle attribute
            await clickRowByDataToggle(page, rowIndex);

            // Wait for the spinner to disappear after clicking the row
            await waitForSpinnerToDisappear(page);

            // Extract the information from the modal or details section
            const data = await extractData(page);

            console.log(`Row ${rowIndex} data:`, data);

            // Close the modal or details section if necessary
            await page.evaluate(() => {
                const closeButton = Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '×');
                if (closeButton) closeButton.click();
            });

            // Wait for the spinner to disappear after closing the modal
            await waitForSpinnerToDisappear(page);

            return; // Exit the function if successful
        } catch (error) {
            if (attempt === maxRetries) {
                throw error; // Rethrow the error if max retries are reached
            }
            console.warn(`Retrying interaction with row due to error: ${error.message}`);
            await delay(1000); // Wait for a second before retrying
        }
    }
}

async function clickRowByDataToggle(page, dataToggleValue) {
    try {
        await page.evaluate((dataToggleValue) => {
            const row = document.querySelector(`tr[data-toggle="${dataToggleValue}"]`);
            if (row) {
                row.click();
            } else {
                throw new Error(`Row with data-toggle="${dataToggleValue}" not found`);
            }
        }, dataToggleValue);
        console.log(`Clicked row with data-toggle="${dataToggleValue}"`);
    } catch (error) {
        console.error(`Error clicking row with data-toggle="${dataToggleValue}":`, error);
    }
}

async function extractData(page) {
    try {
        await waitForSpinnerToDisappear(page);
        await page.evaluate(() => {
            setTimeout(() => {
                const buttons = document.querySelectorAll('.btn.btn-default');
                buttons.forEach(button => {
                    if (button.textContent.trim() === 'Editar') {
                        button.click();
                    }
                });
            });
        });

        // Wait for the input fields to appear on the page
        await page.waitForSelector('input[data-bind^="value: my.vmWeb().newLogin().uid"][readonly]', { timeout: 60000 });
        await page.waitForSelector('input[data-bind="value: my.vmWeb().newLogin().codigoClienteRemitente"][readonly]', { timeout: 60000 });

        // Extract the values from the input fields
        const data = await page.evaluate(() => {
            const uidInput = document.querySelector('input[data-bind^="value: my.vmWeb().newLogin().uid"][readonly]');
            const codigoClienteRemitenteInput = document.querySelector('input[data-bind="value: my.vmWeb().newLogin().codigoClienteRemitente"][readonly]');
            return {
                uid: uidInput ? uidInput.value : null,
                codigoClienteRemitente: codigoClienteRemitenteInput ? codigoClienteRemitenteInput.value : null
            };
        });

        await waitForSpinnerToDisappear(page);
        await page.evaluate(() => {
            setTimeout(() => {
                const buttons = document.querySelectorAll('button');
                buttons.forEach(button => {
                    if (button.textContent.trim() === '×') {
                        button.click();
                    }
                });
            });
        });
        await waitForSpinnerToDisappear(page);
        
        return data;

    } catch (error) {
        console.error('Error extracting data:', error);
    }
}

async function waitForSpinnerToDisappear(page) {
    try {
        await page.waitForFunction(() => {
            const spinner = document.querySelector('.spinner-overlay');
            return !spinner || window.getComputedStyle(spinner).display === 'none';
        }, { timeout: 60000 });
    } catch (error) {
        console.error('Spinner did not disappear:', error);
    }
}

function delay(time) {
    return new Promise(function (resolve) {
        setTimeout(resolve, time);
    });
}

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
