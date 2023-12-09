function checkDOB(dob) {
  const birthDate = new Date(dob);
  const currentDate = new Date();

  const ageInMonths = (currentDate - birthDate) / (1000 * 60 * 60 * 24 * 30.44);

  if (ageInMonths < 12) {
    return "Infant";
  } else if (ageInMonths < 24) {
    return "Toddler";
  } else if (ageInMonths < 36) {
    return "Twaddler";
  } else if (ageInMonths < 48) {
    return "3 Years Old";
  } else {
    return "4 Years Old";
  }
}

function checkAvailability(ageGroup, connection) {
  return new Promise((resolve, reject) => {
    let capacityQuery = "SELECT Capacity FROM classroom WHERE ClassName=?";

    connection.query(capacityQuery, [ageGroup], (error, capacityResults) => {
      if (error) {
        console.error("Error executing capacity query:", error.stack);
        reject("Internal Server Error");
        return;
      }

      let childQuery = "SELECT * FROM Child WHERE AgeGroup=?";
      connection.query(childQuery, [ageGroup], (childError, childResults) => {
        if (childError) {
          console.error("Error executing child query:", childError.stack);
          reject("Internal Server Error");
          return;
        }

        if (childResults.length < capacityResults[0].Capacity) {
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  });
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getCurrentDate() {
  let currentDate = new Date();
  currentDate.setMinutes(
    currentDate.getMinutes() - currentDate.getTimezoneOffset()
  );
  return currentDate;
}

module.exports = { checkDOB, checkAvailability, formatDate, getCurrentDate };
