# Sample Test Plan - QA Playground

## Test Cases

| Test Case Name | Target Jira Issue | Priority | Preconditions | Test Data | Steps | Expected Result |
|---|---|---|---|---|---|---|
| Login with Valid Credentials | KAN-5-1 | High | Navigate to https://www.qaplayground.com/login | Email: testuser@test.com, Password: testpass123 | 1. Enter email in the email field<br/>2. Enter password in the password field<br/>3. Click the Submit button | User should be logged in and redirected to the dashboard |
| Fill Registration Form | KAN-5-2 | High | Navigate to https://www.qaplayground.com/register | First Name: John, Last Name: Doe, Email: john.doe@test.com, Password: TestPass@123 | 1. Fill First Name field with "John"<br/>2. Fill Last Name field with "Doe"<br/>3. Fill Email field with "john.doe@test.com"<br/>4. Fill Password field with "TestPass@123"<br/>5. Check "I agree to terms" checkbox<br/>6. Click Register button | Registration should complete successfully and confirmation message should appear |
