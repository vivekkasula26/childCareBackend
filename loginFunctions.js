const { getCurrentDate } = require("./globalFunctions");

function checkLogin(connection, query, req, res) {
  let { userName, password, userRole } = req.body;

  connection.query(query, [userName, password, userRole], (err, results) => {
    if (err) {
      console.error("Error executing query:", err);
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }
    if (results.length > 0) {
      let result = results[0];
      delete result["password"];
      if (result.roles == "Teacher") {
        recordAttendance(result, connection);
      }
      res.json({ success: true, user: result });
    } else {
      res.json({
        success: false,
        message: "Invalid username or password or user type",
      });
    }
  });
}

function recordAttendance(data, connection, response, signout = false) {
  connection.query(
    "SELECT * FROM staff WHERE email=?",
    [data.email],
    (er, res) => {
      const currentDate = getCurrentDate();
      const staffID = res[0].ID;

      console.log(currentDate);

      const checkQuery = `
    SELECT * FROM StaffAttendance
    WHERE StaffID = ? AND DATE(SignInTime) = ?
     AND SignOutTime IS NULL
  `;

      console.log(currentDate.toISOString().split("T")[0]);

      connection.query(
        checkQuery,
        [staffID, currentDate.toISOString().split("T")[0]],
        (err, result) => {
          if (err) {
            console.error(err);
            return;
          }

          console.log(result);

          if (result.length > 0 && signout) {
            // If a record exists, update it
            const updateQuery = `
              UPDATE StaffAttendance
              SET SignOutTime = ?
              WHERE StaffID = ? AND DATE(SignInTime) = ?
              AND SignOutTime IS NULL
            `;

            connection.query(updateQuery, [
              currentDate,
              staffID,
              currentDate.toISOString().split("T")[0],
            ]);
          } else {
            // If no record exists, insert a new record
            const insertQuery = `
            INSERT INTO StaffAttendance (StaffID, SignInTime)
            VALUES (?, ?)
          `;

            connection.query(insertQuery, [staffID, currentDate]);
          }

          // Calculate and update HoursWorked for the current date
          updateHoursWorked(staffID, connection, response, signout);
        }
      );
    }
  );
}

function updateHoursWorked(staffID, connection, res, signout) {
  const calculateHoursQuery = `
    UPDATE StaffAttendance
    SET HoursWorked = TIMESTAMPDIFF(MINUTE, SignInTime, SignOutTime)
    WHERE StaffID = ?;
  `;

  connection.query(calculateHoursQuery, [staffID], (err) => {
    if (err) {
      console.error(err);
    }
    if (signout) {
      res.json({
        success: true,
      });
    }
  });
}

module.exports = { checkLogin, recordAttendance };
